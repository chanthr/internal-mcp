/**
 * Markdown chunking: split by heading, then a token-aware sub-split, then overlap.
 *
 * Strategy:
 * 1. Split off the front matter (---...---) and extract metadata (promoted to the search payload)
 * 2. Split at each heading (^#{1,6} ) into sections. A "# comment" line inside a code block is not a heading
 * 3. If a section exceeds MAX_TOKENS, sub-split it by paragraph (\n\n)
 *    - Tables (|...|) and code blocks (```) are fence-aware (never cut in the middle of a row or block)
 * 4. Chunks under MIN_TOKENS are merged with a neighbouring chunk
 * 5. The last OVERLAP_TOKENS of the previous chunk are prepended to the start of each chunk
 * 6. Image markdown (![alt](url)): the URL moves to image_urls and only alt stays in content (avoids embedding noise)
 */
import { encode } from 'gpt-tokenizer';
import { parse as parseYaml } from 'yaml';

const MAX_TOKENS = 800;
const MIN_TOKENS = 50;
const OVERLAP_TOKENS = 100;
// Hard cap for one unit (paragraph or sentence). Larger units are force-split to avoid an embedding API Bad Request.
const HARD_MAX_TOKENS = MAX_TOKENS;

export interface RawChunk {
  heading: string;
  content: string;
  tokens: number;
  // ── Image and structure metadata ──
  image_urls: string[];
  table_count: number;
  has_code_block: boolean;
  // ── Front matter fields (per document, identical on every chunk) ──
  doc_status: string | null;
  doc_date: string | null;
  doc_authors: string[];
  doc_related: string[];
  // ── Front matter fields (search links and filters) ──
  doc_tags: string[];
  doc_source_refs: string[];
  doc_affects: string[];
  doc_products: string[];
  doc_type: string | null;
  doc_confidence: string | null;
}

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n+/;

/** CRLF and CR to LF. Files created on Windows did not match the front matter and heading regexes. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function parseFrontmatter(input: string): ParsedDoc {
  const markdown = normalizeNewlines(input);
  const m = markdown.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: markdown };

  // Proper YAML parsing: multi-line lists (related/source_refs/affects), inline arrays and quotes follow the grammar.
  // The old single-line regex read multi-line lists as empty and lost about 89% of related, hence the YAML parser.
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Broken YAML front matter: keep the body, leave metadata empty. One document must not stop the whole indexing run.
    fm = {};
  }
  return { frontmatter: fm, body: markdown.slice(m[0].length) };
}

interface DocMeta {
  doc_status: string | null;
  doc_date: string | null;
  doc_authors: string[];
  doc_related: string[];
  doc_tags: string[];
  doc_source_refs: string[];
  doc_affects: string[];
  doc_products: string[];
  doc_type: string | null;
  doc_confidence: string | null;
}

/** unknown to a normalized string (guards against Date, number, boolean). An empty string becomes null. */
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

/** unknown to string[]. Accepts a YAML array as is, a "[a,b]" or "a,b" string, and a single value. */
function asArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim().replace(/^\[|\]$/g, '');
    if (!s) return [];
    return s
      .split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

/** Front matter (parsed YAML) to search payload metadata. */
function parseDocMeta(fm: Record<string, unknown>): DocMeta {
  return {
    doc_status: asString(fm.status),
    doc_date: asString(fm.date),
    doc_authors: asArray(fm.authors),
    doc_related: asArray(fm.related),
    doc_tags: asArray(fm.tags),
    doc_source_refs: asArray(fm.source_refs),
    doc_affects: asArray(fm.affects),
    doc_products: asArray(fm.products),
    doc_type: asString(fm.type),
    doc_confidence: asString(fm.confidence),
  };
}

function countTokens(text: string): number {
  // gpt-tokenizer defaults to cl100k_base (compatible with text-embedding-3)
  return encode(text).length;
}

// Removes lone surrogates (unpaired UTF-16 surrogates). A cut on a token boundary can split an emoji (surrogate pair)
// and leave one half behind, which the embedding API rejects as invalid with 400 Bad Request.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '');
}

// ![alt](url) is image markdown. The URL moves to image_urls and only alt stays in content, so English URL tokens
// do not skew the embedding vector of Korean text. If alt is empty, the image is removed entirely.
const IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
function extractImages(content: string): { content: string; image_urls: string[] } {
  const urls: string[] = [];
  const cleaned = content.replace(IMAGE_RE, (_full, alt: string, url: string) => {
    urls.push(url);
    return alt ? alt : '';
  });
  return { content: cleaned, image_urls: urls };
}

/** Number of markdown tables in the chunk (approximated by counting `|---|` separator rows). */
function countTables(content: string): number {
  return (content.match(/^\s*\|[\s:|-]+\|\s*$/gm) ?? []).length;
}

/** Whether the text is a markdown table block (70% or more of the rows have the |...| form). */
function isTableBlock(text: string): boolean {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return false;
  const pipeLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  return pipeLines >= lines.length * 0.7;
}

/** Splits a large table by row and prepends the header (first row + separator) to each piece (keeps column names). */
function splitTable(table: string, maxTokens: number): string[] {
  const lines = table.trim().split('\n');
  const sepIdx = lines.findIndex((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l));
  const headerEnd = sepIdx >= 0 ? sepIdx + 1 : 1;
  const header = lines.slice(0, headerEnd).join('\n');
  const bodyRows = lines.slice(headerEnd);
  const headerTok = countTokens(header);
  const out: string[] = [];
  let buf: string[] = [header];
  let bufTok = headerTok;
  for (const row of bodyRows) {
    const rt = countTokens(row);
    if (bufTok + rt > maxTokens && buf.length > 1) {
      out.push(buf.join('\n'));
      buf = [header, row];
      bufTok = headerTok + rt;
    } else {
      buf.push(row);
      bufTok += rt;
    }
  }
  if (buf.length > 1) out.push(buf.join('\n'));
  return out.length > 0 ? out : [table];
}

/** Splits into paragraphs on \n\n while protecting code blocks (```). A code block stays whole as one unit. */
function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const seg of text.split(/(```[\s\S]*?```)/g)) {
    if (seg.startsWith('```')) {
      if (seg.trim()) out.push(seg.trim());
    } else {
      for (const p of seg.split(/\n\n+/)) {
        if (p.trim()) out.push(p.trim());
      }
    }
  }
  return out;
}

/**
 * Conservative sentence split for Korean and English, based on terminal punctuation and newlines.
 * If the split fails, the original text is returned as one item (nothing is lost).
 */
function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?。…])\s+|(?<=[가-힣][다요죠음임함됨까네]\.)\s+|(?<=\n)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [text];
}

/**
 * Hard cut by characters (last resort when even a sentence exceeds the cap).
 * A binary search finds the longest prefix within maxTokens.
 */
function hardCutByChars(text: string, maxTokens: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (countTokens(rest) <= maxTokens) {
      out.push(rest);
      break;
    }
    let lo = 1;
    let hi = rest.length;
    let cut = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (countTokens(rest.slice(0, mid)) <= maxTokens) {
        cut = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

/** The suffix of text that fits in the last maxTokens tokens (for the overlap, binary search). */
function tailByTokens(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length - 1;
  let cut = text.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (countTokens(text.slice(mid)) <= maxTokens) {
      cut = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return text.slice(cut);
}

/**
 * Force-splits a unit over the maximum. A table is split by row (header repeated). Other text is packed by sentence
 * within the budget, with a hard cut by characters as the fallback.
 * Every returned unit is guaranteed to be within maxTokens.
 */
function splitLongText(text: string, maxTokens: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  // Tables are split by row (the header is prepended to each piece)
  if (isTableBlock(text)) return splitTable(text, maxTokens);

  const out: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  const flush = () => {
    if (buf.length > 0) {
      out.push(buf.join(' '));
      buf = [];
      bufTokens = 0;
    }
  };

  for (const sentence of splitSentences(text)) {
    const st = countTokens(sentence);
    if (st > maxTokens) {
      flush();
      out.push(...hardCutByChars(sentence, maxTokens));
      continue;
    }
    if (bufTokens + st > maxTokens && buf.length > 0) flush();
    buf.push(sentence);
    bufTokens += st;
  }
  flush();
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Cuts body into sections at each heading line. Lines inside a code block (``` or ~~~) are not treated as headings.
 * Cutting at a shell or Python comment ("# install") split the code in half and put the comment into the breadcrumb.
 */
function splitSections(body: string): string[] {
  const sections: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null; // marker string of the open fence (``` or ~~~)
  for (const line of body.split('\n')) {
    const f = line.match(FENCE_RE);
    if (f) {
      if (fence === null) fence = f[1];
      // A closing fence uses the same character, is at least as long, and has no info string after it (CommonMark)
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
    } else if (fence === null && HEADING_RE.test(line) && buf.length > 0) {
      sections.push(buf.join('\n'));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length > 0) sections.push(buf.join('\n'));
  return sections;
}

/**
 * Heading level (number of #) and text from the first line of a section, used to build the breadcrumb
 * (parent > child). Returns null if the first line is not a heading.
 */
function extractHeading(section: string): { level: number; text: string } | null {
  const m = section.split('\n', 1)[0].match(HEADING_RE);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

interface PreChunk {
  heading: string;
  content: string;
  tokens: number;
}

/**
 * Full markdown to an array of chunks. Keeps the heading context and image/table/code/front matter metadata.
 */
export function chunkMarkdown(markdown: string): RawChunk[] {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const docMeta = parseDocMeta(frontmatter);
  if (body.trim().length === 0) return [];

  const sections = splitSections(body);
  const chunks: PreChunk[] = [];
  const headingStack: string[] = []; // index = (heading level - 1), keeps the parent > child breadcrumb context
  let currentHeading = ''; // body before the first heading has no heading (older versions used a Korean placeholder here)

  for (const section of sections) {
    if (section.trim().length === 0) continue;

    const h = extractHeading(section);
    if (h) {
      headingStack.length = h.level - 1; // drop entries at the same or a deeper level
      headingStack[h.level - 1] = h.text; // then set the current level
      const crumb = headingStack.filter(Boolean).join(' > ');
      if (crumb) currentHeading = crumb;
    }

    const tokens = countTokens(section);
    if (tokens <= MAX_TOKENS) {
      chunks.push({ heading: currentHeading, content: section.trim(), tokens });
      continue;
    }

    const paragraphs = splitParagraphs(section).flatMap((p) =>
      countTokens(p) > HARD_MAX_TOKENS ? splitLongText(p, HARD_MAX_TOKENS) : [p],
    );
    let buf: string[] = [];
    let bufTokens = 0;
    for (const para of paragraphs) {
      const pt = countTokens(para);
      if (bufTokens + pt > MAX_TOKENS && buf.length > 0) {
        chunks.push({ heading: currentHeading, content: buf.join('\n\n').trim(), tokens: bufTokens });
        buf = [];
        bufTokens = 0;
      }
      buf.push(para);
      bufTokens += pt;
    }
    if (buf.length > 0) {
      chunks.push({ heading: currentHeading, content: buf.join('\n\n').trim(), tokens: bufTokens });
    }
  }

  // Merge chunks under MIN_TOKENS
  const merged: PreChunk[] = [];
  for (const c of chunks) {
    if (c.tokens < MIN_TOKENS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.content = `${prev.content}\n\n${c.content}`;
      prev.tokens += c.tokens;
    } else {
      merged.push({ ...c });
    }
  }

  // 1. Separate image URLs, strip surrogates and compute metadata from each chunk's own content, before the overlap.
  //    (Computing after the overlap would leak the previous chunk's images and code into the next chunk's metadata.)
  const withMeta = merged.map((c) => {
    const tableCount = countTables(c.content);
    const hasCode = /```/.test(c.content);
    const { content: imgStripped, image_urls } = extractImages(c.content);
    return {
      heading: c.heading,
      content: stripLoneSurrogates(imgStripped),
      image_urls,
      table_count: tableCount,
      has_code_block: hasCode,
    };
  });

  // 2. Prepend the overlap: a text suffix with image URLs already removed (no URL gets into the overlap).
  //    Warning: tailByTokens cuts on a token boundary, so it can cut an emoji (surrogate pair) in half.
  //    If that lone surrogate reaches the Qdrant payload content, the JSON is invalid UTF-8 and the upsert returns 400.
  //    Step 3 below strips the final content once more to remove it.
  for (let i = 1; i < withMeta.length; i++) {
    const overlap = tailByTokens(withMeta[i - 1].content, OVERLAP_TOKENS);
    if (overlap) withMeta[i].content = `…${overlap}\n\n${withMeta[i].content}`;
  }

  // 3. Final RawChunk: strip lone surrogates created by the overlap again (prevents Qdrant 400), attach front matter.
  return withMeta.map((c) => {
    const content = stripLoneSurrogates(c.content);
    return {
      heading: c.heading,
      content,
      tokens: countTokens(content),
      image_urls: c.image_urls,
      table_count: c.table_count,
      has_code_block: c.has_code_block,
      ...docMeta,
    };
  });
}
