/**
 * Markdown chunking: split by heading, then a token-aware sub-split, then overlap.
 *
 * The sizes below (MAX_TOKENS, MIN_TOKENS, OVERLAP_TOKENS) and whether headings are cut at come from the index
 * profile (index_profile.ts): 800, 50 and 100 at headings unless set otherwise.
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
import { indexProfile, type IndexProfile } from './index_profile.js';

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

/**
 * A string such as "<|endoftext|>" in a document is read as the text it is. By default the tokenizer refuses one, and
 * a document that held one was never indexed.
 */
const AS_TEXT = { disallowedSpecial: new Set<string>() };

/**
 * Places where the tokenizer always ends a token, and reads the text before and after the same way when the text is
 * cut there: a space or a tab after anything but white space, anything but a letter, a mark or an apostrophe after a
 * letter, anything after a digit, a digit after anything but a digit or white space, and anything but white space or
 * "/" after a line break. (Spaces at the end of a part are read differently from the same spaces before a word.)
 * Text cut at these places counts the same in parts as whole.
 */
const WORD_END = /(?<=\S)(?=[^\S\r\n])|(?<=\p{L})(?=[^\p{L}\p{M}'])|(?<=\p{N})(?=\P{N})|(?<=[^\p{N}\s])(?=\p{N})|(?<=[\r\n])(?=[^\s/])/gu;
/**
 * A stretch of more than LONGEST_WORD bytes (in UTF-8) with no such place in it is not prose (a line of one
 * character, a page of Korean or Chinese with no space or punctuation in it), and is read in pieces of WORD_PIECE
 * characters. The tokenizer's work on one word grows with the square of its bytes: 100 KB of "a" took 29 seconds to
 * cut, and 8,000 Korean characters without a space took a second. Ordinary text has no such stretch (the padding of
 * a wide table is a few hundred spaces), so it counts the same as before.
 */
const LONGEST_WORD = 1024;
const WORD_PIECE = 32;
/** Characters of text given to the tokenizer at once when counting, and when a cut is searched for. */
const COUNT_PART = 2000;
const SEARCH_PART = 64;

/** UTF-8 bytes of text.slice(from, to), counted no further than just past `most`. */
function utf8Bytes(text: string, from: number, to: number, most: number): number {
  let n = 0;
  for (let i = from; i < to && n <= most; i++) {
    const c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
  }
  return n;
}

/** The places text is cut for counting, in order, each with whether it must be cut there (inside a long stretch). */
function* cutPlaces(text: string): Generator<[at: number, must: boolean]> {
  let last = 0;
  // Three bytes at most to a UTF-16 unit: a stretch of no more than a third of LONGEST_WORD units is never long.
  const long = (to: number) => to - last > LONGEST_WORD / 3 && utf8Bytes(text, last, to, LONGEST_WORD) > LONGEST_WORD;
  function* inside(to: number): Generator<[number, boolean]> {
    let at = last;
    while (to - at > WORD_PIECE) {
      at += WORD_PIECE;
      // Not between the two halves of a character outside the basic plane (an emoji).
      const c = text.charCodeAt(at - 1);
      if (c >= 0xd800 && c <= 0xdbff) at--;
      yield [at, true];
    }
  }
  for (const m of text.matchAll(WORD_END)) {
    if (long(m.index!)) yield* inside(m.index!);
    yield [m.index!, false];
    last = m.index!;
  }
  if (long(text.length)) yield* inside(text.length);
}

/**
 * Text in consecutive parts of about `most` characters, cut only at cutPlaces. `piece` is set on a part that begins
 * or ends where a long stretch was cut by force (a part of something that is not prose).
 */
function* tokenParts(text: string, most: number): Generator<{ text: string; piece: boolean }> {
  if (text.length <= Math.min(most, LONGEST_WORD / 3)) {
    yield { text, piece: false };
    return;
  }
  let start = 0;
  let prev = 0; // the last place passed, after start
  let forcedStart = false;
  const part = (end: number, forcedEnd: boolean) => {
    const p = { text: text.slice(start, end), piece: forcedStart || forcedEnd };
    start = end;
    forcedStart = forcedEnd;
    return p;
  };
  for (const [at, must] of cutPlaces(text)) {
    if (at - start > most && prev > start) yield part(prev, false);
    if (must) yield part(at, true);
    prev = at;
  }
  if (text.length - start > most && prev > start) yield part(prev, false);
  yield part(text.length, false);
}

/**
 * Tokens of the parts met while one document is cut. A part met again (a long run of one character is cut into many
 * equal ones) is not given to the tokenizer again: its own cache moves a word it is asked for again to the end of a
 * Map, which grows slow (some microseconds each time) once the Map holds thousands of words.
 */
let seenParts: Map<string, number> | null = null;

/** Tokens of text the tokenizer is given whole: a part from tokenParts, or less. */
function tokensOf(part: string): number {
  let n = seenParts?.get(part);
  if (n === undefined) {
    n = encode(part, AS_TEXT).length;
    seenParts?.set(part, n);
  }
  return n;
}

/**
 * Tokens in text (gpt-tokenizer's default encoding). Counted in parts (tokenParts), the same total as whole for
 * prose. With `stop`, counting ends once there are more than that: what is over a cap is not counted to its end.
 */
function countTokens(text: string, stop = Infinity): number {
  let n = 0;
  for (const part of tokenParts(text, COUNT_PART)) {
    n += tokensOf(part.text);
    if (n > stop) break;
  }
  return n;
}

// Removes lone surrogates (unpaired UTF-16 surrogates). A cut on a token boundary can split an emoji (surrogate pair)
// and leave one half behind, which the embedding API rejects as invalid with 400 Bad Request.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '');
}

// ![alt](url) is image markdown. The URL moves to image_urls and only alt stays in content, so English URL tokens
// do not skew the embedding vector of Korean text. If alt is empty, the image is removed entirely. The alt text does
// not read past the next "[": a chunk of "![" over and over was read to its end from every one of them.
const IMAGE_RE = /!\[([^[\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
function extractImages(content: string): { content: string; image_urls: string[] } {
  const urls: string[] = [];
  const cleaned = content.replace(IMAGE_RE, (_full, alt: string, url: string) => {
    urls.push(url);
    return alt ? alt : '';
  });
  return { content: cleaned, image_urls: urls };
}

/**
 * Number of markdown tables in the chunk (approximated by counting `|---|` separator rows). Spaces and tabs only:
 * \s crossed lines, and every line of a run of blank lines read the whole run.
 */
function countTables(content: string): number {
  return (content.match(/^[ \t]*\|[ \t:|-]+\|[ \t]*$/gm) ?? []).length;
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

/** Text in parts (tokenParts) with the tokens of each, so that any stretch of it is counted part by part. */
interface Counted {
  text: string;
  /** Where each part begins, then the end of the text. */
  starts: number[];
  tokens: number[];
  /** before[i]: the tokens of the parts before part i. */
  before: number[];
  /** The part is a piece of a long stretch cut by force (tokenParts). */
  piece: boolean[];
  /** Tokens of stretches that end inside a part, counted once. */
  seen: Map<string, number>;
}

function counted(text: string): Counted {
  const c: Counted = { text, starts: [0], tokens: [], before: [0], piece: [], seen: new Map() };
  for (const part of tokenParts(text, SEARCH_PART)) {
    const n = tokensOf(part.text);
    c.tokens.push(n);
    c.before.push(c.before[c.before.length - 1] + n);
    c.starts.push(c.starts[c.starts.length - 1] + part.text.length);
    c.piece.push(part.piece);
  }
  return c;
}

/** The part that holds the character at `at`. */
function partAt(c: Counted, at: number): number {
  let lo = 0;
  let hi = c.tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A part of more bytes than this (a stretch with no place to cut in it, too short to be cut by force) is not searched
 * one character at a time: the tokens of a piece of it are taken in proportion to its length, and the cut that comes
 * of that is checked once at the end. Searching such parts one character at a time took over a second for 200 KB
 * of Korean in runs of 300 characters.
 */
const LONG_PART = 256;

/**
 * Whether text.slice(from, to) is within max tokens, counted as its parts are. The whole parts in it are added up;
 * a part it cuts at either end is given to the tokenizer only when the sum leaves the answer open (a UTF-16 unit is
 * at most three bytes, so at most three tokens), and, unless `exact`, a long part is estimated (LONG_PART).
 */
function fits(c: Counted, from: number, to: number, max: number, exact = false): boolean {
  if (to <= from) return true;
  const i = partAt(c, from);
  const j = partAt(c, to - 1);
  let n = 0;
  const ends: Array<[number, number, number]> = [];
  const add = (k: number, a: number, b: number) => {
    if (a === c.starts[k] && b === c.starts[k + 1]) n += c.tokens[k];
    else ends.push([k, a, b]);
  };
  if (i === j) add(i, from, to);
  else {
    add(i, from, c.starts[i + 1]);
    n += c.before[j] - c.before[i + 1];
    add(j, c.starts[j], to);
  }
  if (n > max) return false;
  if (ends.reduce((most, [, a, b]) => most + 3 * (b - a), n) <= max) return true;
  for (const [k, a, b] of ends) {
    const length = c.starts[k + 1] - c.starts[k];
    if (!exact && length > LONG_PART / 3 && utf8Bytes(c.text, c.starts[k], c.starts[k + 1], LONG_PART) > LONG_PART) {
      // In proportion, with two to spare: the check at the end then seldom has to move the cut.
      n += Math.ceil((c.tokens[k] * (b - a)) / length) + 2;
      continue;
    }
    const key = `${a}:${b}`;
    let t = c.seen.get(key);
    if (t === undefined) c.seen.set(key, (t = tokensOf(c.text.slice(a, b))));
    n += t;
  }
  return n <= max;
}

/**
 * Hard cut by characters (last resort when even a sentence exceeds the cap).
 * A binary search finds the longest prefix within maxTokens. The text is counted once, in parts (counted); a step of
 * the search adds up parts and gives the tokenizer only the part it ends in. (Counting the whole rest again for
 * every cut and every step took minutes on 100 KB.)
 */
function hardCutByChars(text: string, maxTokens: number): string[] {
  const c = counted(text);
  if (fits(c, 0, text.length, maxTokens)) return [text];
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (fits(c, at, text.length, maxTokens, true)) {
      out.push(text.slice(at));
      break;
    }
    let lo = 1;
    let hi = text.length - at;
    let cut = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(c, at, at + mid, maxTokens)) {
        cut = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const j = partAt(c, at + cut);
    const inside = c.starts[j] > at && c.starts[j] < at + cut;
    if (c.piece[j] && inside) {
      // Inside a stretch that is not prose, the cut goes where its pieces begin: the rest then begins where they do,
      // and is counted from the same pieces again instead of new ones.
      cut = c.starts[j] - at;
    } else {
      // A cut that an estimate placed inside a long part is moved back, a tenth of what it takes of that part at a
      // time, while what it leaves holds too much.
      while (cut > 1 && !fits(c, at, at + cut, maxTokens, true)) {
        const base = Math.max(at, c.starts[partAt(c, at + cut - 1)]);
        cut = Math.max(1, Math.min(cut - 1, base - at + Math.floor((at + cut - base) * 0.9)));
      }
    }
    out.push(text.slice(at, at + cut));
    at += cut;
  }
  return out;
}

/** The suffix of text that fits in the last maxTokens tokens (for the overlap, binary search, counted as above). */
function tailByTokens(text: string, maxTokens: number): string {
  const c = counted(text);
  if (fits(c, 0, text.length, maxTokens, true)) return text;
  let lo = 0;
  let hi = text.length - 1;
  let cut = text.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(c, mid, text.length, maxTokens)) {
      cut = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  // A start that an estimate placed inside a long part is moved on, a tenth of the rest of that part at a time, while
  // what follows it holds too much.
  while (cut < text.length - 1 && !fits(c, cut, text.length, maxTokens, true)) {
    const end = c.starts[partAt(c, cut) + 1];
    cut = Math.min(text.length - 1, Math.max(cut + 1, end - Math.floor((end - cut) * 0.9)));
  }
  return text.slice(cut);
}

/**
 * Force-splits a unit over the maximum. A table is split by row (header repeated). Other text is packed by sentence
 * within the budget, with a hard cut by characters as the fallback.
 * Every returned unit is guaranteed to be within maxTokens.
 */
function splitLongText(text: string, maxTokens: number): string[] {
  if (countTokens(text, maxTokens) <= maxTokens) return [text];
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
    const st = countTokens(sentence, maxTokens);
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
export function chunkMarkdown(markdown: string, profile: IndexProfile = indexProfile()): RawChunk[] {
  seenParts = new Map();
  try {
    return cutDocument(markdown, profile);
  } finally {
    seenParts = null;
  }
}

function cutDocument(markdown: string, profile: IndexProfile): RawChunk[] {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const docMeta = parseDocMeta(frontmatter);
  if (body.trim().length === 0) return [];
  const MAX_TOKENS = profile.maxTokens;
  const MIN_TOKENS = profile.minTokens;
  const OVERLAP_TOKENS = profile.overlapTokens;
  // Hard cap for one unit (paragraph or sentence). Larger units are force-split to avoid an embedding API Bad Request.
  const HARD_MAX_TOKENS = MAX_TOKENS;

  // "windows": the document is one run of paragraphs. Headings stay in the text and are not cut at.
  const sections = profile.cut === 'windows' ? [body] : splitSections(body);
  const chunks: PreChunk[] = [];
  const headingStack: string[] = []; // index = (heading level - 1), keeps the parent > child breadcrumb context
  let currentHeading = ''; // body before the first heading has no heading (older versions used a Korean placeholder here)

  for (const section of sections) {
    if (section.trim().length === 0) continue;

    const h = profile.cut === 'windows' ? null : extractHeading(section);
    if (h) {
      headingStack.length = h.level - 1; // drop entries at the same or a deeper level
      headingStack[h.level - 1] = h.text; // then set the current level
      const crumb = headingStack.filter(Boolean).join(' > ');
      if (crumb) currentHeading = crumb;
    }

    const tokens = countTokens(section, MAX_TOKENS);
    if (tokens <= MAX_TOKENS) {
      chunks.push({ heading: currentHeading, content: section.trim(), tokens });
      continue;
    }

    const paragraphs = splitParagraphs(section).flatMap((p) =>
      countTokens(p, HARD_MAX_TOKENS) > HARD_MAX_TOKENS ? splitLongText(p, HARD_MAX_TOKENS) : [p],
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
    const overlap = OVERLAP_TOKENS > 0 ? tailByTokens(withMeta[i - 1].content, OVERLAP_TOKENS) : '';
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
