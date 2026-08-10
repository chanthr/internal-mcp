/**
 * Markdown chunking — heading 기반 분할 + token-aware sub-split + overlap.
 *
 * 전략:
 * 1. Front-matter (---...---) 분리 → metadata 추출 (검색 payload 승격)
 * 2. heading (^#+ ) 위치마다 split → section
 * 3. 각 section 이 MAX_TOKENS 넘으면 paragraph (\n\n) 단위로 sub-split
 *    - 표(|...|)·코드블록(```) 은 fence-aware (행/블록 중간에서 안 잘림)
 * 4. MIN_TOKENS 미만은 다음 청크와 merge
 * 5. 청크 시작에 OVERLAP_TOKENS 만큼 이전 청크 끝 prepend
 * 6. 이미지 markdown(![alt](url)) → URL 은 image_urls 로 분리, content 엔 alt 만 (임베딩 노이즈 방지)
 */
import { encode } from 'gpt-tokenizer';
import { parse as parseYaml } from 'yaml';

const MAX_TOKENS = 800;
const MIN_TOKENS = 50;
const OVERLAP_TOKENS = 100;
// 단일 unit(문단/문장)의 절대 상한 — 초과 시 강제 분할. 임베딩 API 입력 초과(Bad Request) 방지.
const HARD_MAX_TOKENS = MAX_TOKENS;

export interface RawChunk {
  heading: string;
  content: string;
  tokens: number;
  // ── 이미지·구조 메타 (2026-05-27 RAG 개선) ──
  image_urls: string[];
  table_count: number;
  has_code_block: boolean;
  // ── frontmatter 승격 (문서 단위 — 모든 청크 동일) ──
  doc_status: string | null;
  doc_tier: string | null;
  doc_date: string | null;
  doc_authors: string[];
  doc_related: string[];
  // ── frontmatter 승격 (신규: 검색 연결·필터) ──
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

export function parseFrontmatter(markdown: string): ParsedDoc {
  const m = markdown.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: markdown };

  // 정식 YAML 파싱 — multi-line list(related/source_refs/affects)·inline 배열·따옴표를 문법대로.
  // (구 단일라인 정규식은 multi-line list 를 빈 값으로 버려 related 의 ~89% 유실 → yaml 파서로 교체)
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // 깨진 YAML frontmatter — 본문은 보존, 메타만 빈값 (fail-safe: 한 문서가 색인 전체를 멈추지 않게)
    fm = {};
  }
  return { frontmatter: fm, body: markdown.slice(m[0].length) };
}

interface DocMeta {
  doc_status: string | null;
  doc_tier: string | null;
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

/** unknown → 정규화 문자열 (Date·number·bool 방어). 빈 문자열은 null. */
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

/** unknown → string[]. yaml 배열 그대로 / "[a,b]"·"a,b" 문자열 / 단일값 모두 흡수. */
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

/** frontmatter(yaml 파싱 결과) → 검색 payload 메타. */
function parseDocMeta(fm: Record<string, unknown>): DocMeta {
  return {
    doc_status: asString(fm.status),
    doc_tier: asString(fm.tier),
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
  // gpt-tokenizer 는 cl100k_base (text-embedding-3 호환) 기본
  return encode(text).length;
}

// lone surrogate (짝 안 맞는 UTF-16 surrogate) 제거 — 토큰 경계 cut 이 이모지(surrogate pair)를
// 중간에 쪼개 반쪽만 남으면 임베딩 API 가 invalid 로 400 Bad Request.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '');
}

// ![alt](url) — 이미지 markdown. URL 은 image_urls 로 분리, content 엔 alt 만 (영문 URL 토큰이
// 한국어 임베딩 벡터를 흔드는 것 방지). alt 가 비면 자리 제거.
const IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
function extractImages(content: string): { content: string; image_urls: string[] } {
  const urls: string[] = [];
  const cleaned = content.replace(IMAGE_RE, (_full, alt: string, url: string) => {
    urls.push(url);
    return alt ? alt : '';
  });
  return { content: cleaned, image_urls: urls };
}

/** 청크 내 markdown table 개수 (separator 행 `|---|` 수로 근사). */
function countTables(content: string): number {
  return (content.match(/^\s*\|[\s:|-]+\|\s*$/gm) ?? []).length;
}

/** markdown table block 인지 (행 70%+ 가 |...| 형태). */
function isTableBlock(text: string): boolean {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return false;
  const pipeLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  return pipeLines >= lines.length * 0.7;
}

/** 큰 표를 행 단위로 분할 + 각 조각에 header(첫 행 + separator) prepend (컬럼명 보존). */
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

/** 코드블록(```) 보호하며 \n\n paragraph split. 코드블록은 통째 1 unit. */
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
 * 한국어·영어 문장 분리 (보수적). 종결부호/개행 기준. 분리 실패 시 원문 1개 (손실 X).
 */
function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?。…])\s+|(?<=[가-힣][다요죠음임함됨까네]\.)\s+|(?<=\n)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [text];
}

/**
 * 문자 단위 hard cut (문장조차 상한 초과 시 최후 수단). 이진탐색으로 maxTokens 이하 최대 prefix.
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

/** text 의 마지막 maxTokens 토큰에 해당하는 suffix (overlap 용, 이진탐색). */
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
 * MAX 초과 unit 강제 분할. 표면 행 단위(header 반복), 아니면 문장 budget → 문자 hard cut.
 * 모든 반환 unit 은 maxTokens 이하 보장.
 */
function splitLongText(text: string, maxTokens: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  // 표는 행 단위 분리 (각 조각 header prepend)
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

/** heading line 의 레벨(#개수)+텍스트 추출 — breadcrumb(상위 > 하위) 구성용. */
function extractHeading(text: string): { level: number; text: string } | null {
  const m = text.match(/^(#+)\s+(.+)$/m);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

interface PreChunk {
  heading: string;
  content: string;
  tokens: number;
}

/**
 * 전체 markdown → 청크 array. heading context + 이미지/표/코드/frontmatter 메타 보존.
 */
export function chunkMarkdown(markdown: string): RawChunk[] {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const docMeta = parseDocMeta(frontmatter);
  if (body.trim().length === 0) return [];

  const sections = body.split(/\n(?=#+ )/);
  const chunks: PreChunk[] = [];
  const headingStack: string[] = []; // index = (heading level - 1) → breadcrumb 상위>하위 맥락 보존
  let currentHeading = '문서 시작';

  for (const section of sections) {
    if (section.trim().length === 0) continue;

    const h = extractHeading(section);
    if (h) {
      headingStack.length = h.level - 1; // 같거나 더 깊은 레벨 잘라내고
      headingStack[h.level - 1] = h.text; // 현재 레벨 갱신
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

  // MIN_TOKENS 미만 청크 merge
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

  // 1. 이미지 URL 분리 + surrogate strip + 메타 계산 — overlap *전* 고유 content 기준.
  //    (overlap 후 계산하면 이전 청크의 이미지/코드가 인접 청크 메타에 오염됨)
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

  // 2. Overlap prepend — 이미지 URL 이 이미 분리된 텍스트 suffix (overlap 에 URL 안 섞임).
  //    ⚠️ tailByTokens 는 토큰 경계로 자르므로 이모지(surrogate pair)를 반토막 낼 수 있다.
  //    이 lone surrogate 가 Qdrant payload content 에 들어가면 invalid UTF-8 JSON → upsert 400.
  //    → 아래 3단계에서 최종 content 에 strip 을 한 번 더 적용해 제거한다.
  for (let i = 1; i < withMeta.length; i++) {
    const overlap = tailByTokens(withMeta[i - 1].content, OVERLAP_TOKENS);
    if (overlap) withMeta[i].content = `…${overlap}\n\n${withMeta[i].content}`;
  }

  // 3. 최종 RawChunk — overlap 후 재생성된 lone surrogate 재제거(Qdrant 400 방지) + frontmatter 동봉.
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
