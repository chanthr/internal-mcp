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
import { clearMergeCache, encode, setMergeCacheSize } from 'gpt-tokenizer';
import { parseDocument, visit } from 'yaml';
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

/**
 * Front matter longer than this is not read for metadata: what is in it is cut off from the body all the same. A
 * header is a few lines; one of 200,000 characters is not, and reading it takes time.
 */
const MAX_FRONTMATTER = 64 * 1024;

export function parseFrontmatter(input: string): ParsedDoc {
  const markdown = normalizeNewlines(input);
  const m = markdown.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: markdown };

  // Proper YAML parsing: multi-line lists (related/source_refs/affects), inline arrays and quotes follow the grammar.
  // The old single-line regex read multi-line lists as empty and lost about 89% of related, hence the YAML parser.
  // Broken YAML front matter (or too long, or a key given twice): keep the body, leave metadata empty. One document
  // must not stop the whole indexing run.
  return { frontmatter: m[1].length > MAX_FRONTMATTER ? {} : readYaml(m[1]), body: markdown.slice(m[0].length) };
}

/**
 * The YAML of a front matter as an object, or {} when it is not one. A key given twice in a mapping makes it
 * unreadable, as the YAML parser has it; the parser's own check of that compared every key with every other one (40,000
 * keys: 5 seconds), so it is turned off and done here with a set per mapping.
 */
function readYaml(text: string): Record<string, unknown> {
  try {
    const doc = parseDocument(text, { uniqueKeys: false });
    if (doc.errors.length > 0) return {};
    let twice = false;
    visit(doc, {
      Map(_key, map) {
        const seen = new Set<unknown>();
        for (const item of map.items) {
          const k = item.key as { value?: unknown } | null;
          if (!k || typeof k !== 'object' || !('value' in k) || (k as { items?: unknown }).items !== undefined) continue;
          if (seen.has(k.value)) {
            twice = true;
            return visit.BREAK;
          }
          seen.add(k.value);
        }
      },
    });
    if (twice) return {};
    const parsed = doc.toJS();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
 * The tokenizer keeps the last 100,000 words it was given in a Map, and once the Map is full each new word first takes
 * out the oldest one, which grows slow: after a megabyte of words not seen before, each document of 200,000
 * characters took a second, and one of 4 MB took 18 seconds. Its Map is never let fill up: it is emptied once the
 * tokenizer has been given TOKENIZER_PARTS parts (see tokensOf), a word or a few each, or TOKENIZER_CHARS characters
 * (a part can be a stretch of hundreds). Kept between documents, the words in it still save time (Korean text was cut
 * in a third more time without it). This module is the only one that uses the tokenizer.
 */
setMergeCacheSize(Number.MAX_SAFE_INTEGER);
const TOKENIZER_PARTS = 100_000;
const TOKENIZER_CHARS = 2_000_000;
let partsGiven = 0;
let charsGiven = 0;

/**
 * Places where the tokenizer always ends a token, and reads the text before and after the same way when the text is
 * cut there: a space or a tab after anything but white space, anything but a letter, a mark or an apostrophe after a
 * letter, anything after a digit, a digit after anything but a digit or white space, and anything but white space or
 * "/" after a line break. (Spaces at the end of a part are read differently from the same spaces before a word.)
 * Text cut at these places counts the same in pieces as whole.
 */
const WORD_END = /(?<=\S)(?=[^\S\r\n])|(?<=\p{L})(?=[^\p{L}\p{M}'])|(?<=\p{N})(?=\P{N})|(?<=[^\p{N}\s])(?=\p{N})|(?<=[\r\n])(?=[^\s/])/gu;
/** The same places, tested at one position. */
const WORD_END_AT = new RegExp(WORD_END.source, 'uy');
/**
 * A stretch of more than LONGEST_WORD bytes (in UTF-8) with no such place in it is not prose (a line of one
 * character, a page of Korean or Chinese with no space or punctuation in it), and is read in pieces of WORD_PIECE
 * characters. The tokenizer's work on one word grows with the square of its bytes: 100 KB of "a" took 29 seconds to
 * cut, and 8,000 Korean characters without a space took a second. The longest stretches of ordinary text (a Thai
 * sentence with no space, the rule of a wide table) are a few hundred bytes.
 */
const LONGEST_WORD = 768;
const WORD_PIECE = 32;
/**
 * Tokens a cut by force may hide. Read apart, two pieces of one run can come to fewer tokens than the run read whole
 * (the tokenizer joins letters across the cut differently): "la" over and over was 14% short in 32-character pieces,
 * two tokens a piece. Each such cut counts as two tokens more, so that what is counted is not less than what is there;
 * except between two pieces of one character over and over (a rule of "─", a run of spaces), which read whole never
 * come to more tokens than apart (every character of the basic plane tried, in runs of 769, 801, 1,100 and 1,117),
 * and are counted as they are. Not so when fewer than WORD_PIECE + 1 characters follow the cut: what comes after is
 * not known to be the same character (">" 33 times is six tokens, 32 and 1 are five). Not a digit either (see
 * stretchPlaces).
 */
const PIECE_MARGIN = 2;
const NUMBER_AT = /\p{N}/uy;

/** The margin of a cut by force at `at` (see PIECE_MARGIN). */
function marginAt(text: string, at: number): number {
  if (at + WORD_PIECE + 1 > text.length) return PIECE_MARGIN;
  const c = text.charCodeAt(at);
  const from = Math.max(0, at - WORD_PIECE - 1);
  const to = Math.min(text.length, at + WORD_PIECE + 1);
  // Two code units for a character outside the basic plane: compared one unit apart then.
  const step = c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) !== text.charCodeAt(at + ((((i - at) % step) + step) % step))) return PIECE_MARGIN;
  NUMBER_AT.lastIndex = at;
  return NUMBER_AT.test(text) ? PIECE_MARGIN : 0;
}

/** UTF-8 bytes of text.slice(from, to), counted no further than just past `most`. */
function utf8Bytes(text: string, from: number, to: number, most: number): number {
  let n = 0;
  for (let i = from; i < to && n <= most; i++) {
    const c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
  }
  return n;
}

/** Whether `at` is between the two halves of a character outside the basic plane. */
function splitsPair(text: string, at: number): boolean {
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** UTF-16 units of the digit (any number character) that begins at `at`, or 0 when there is none. */
function numberAt(text: string, at: number): number {
  if (at >= text.length || splitsPair(text, at)) return 0;
  NUMBER_AT.lastIndex = at;
  return NUMBER_AT.test(text) ? NUMBER_AT.lastIndex - at : 0;
}

/** UTF-16 units of the digit that ends at `at`, or 0 when there is none. */
function numberBefore(text: string, at: number): number {
  if (at <= 0) return 0;
  const high = text.charCodeAt(at - 2);
  const low = text.charCodeAt(at - 1);
  const start = at >= 2 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? at - 2 : at - 1;
  return numberAt(text, start) === at - start ? at - start : 0;
}

/**
 * Digits are read in groups of three from the first of a run ("0６0" is one group), so a run is cut every DIGIT_PIECE
 * digits from there: where the whole ends a group too, and the pieces count as the whole does. Cut every 32
 * characters, the groups of each piece were not those of the whole, and "0６0" over and over came to 931 tokens in a
 * passage counted as 800.
 */
const DIGIT_PIECE = 30;

/**
 * The places a stretch with no word end is cut at, from `from` to `to`. A stretch with a digit in it is white space,
 * then digits (a word ends after a digit, and before one after anything but white space): the white space is cut
 * every WORD_PIECE characters (`must`), and the digits every DIGIT_PIECE digits, where a cut is exact.
 */
function* stretchPlaces(text: string, from: number, to: number): Generator<[at: number, must: boolean]> {
  let digits = to;
  for (let n = numberBefore(text, digits); n > 0 && digits - n >= from; n = numberBefore(text, digits)) digits -= n;
  let at = from;
  while (digits - at > WORD_PIECE) {
    at += WORD_PIECE;
    // Not between the two halves of a character outside the basic plane (an emoji).
    const c = text.charCodeAt(at - 1);
    if (c >= 0xd800 && c <= 0xdbff) at--;
    yield [at, true];
  }
  for (let p = digits, k = 0; p < to; ) {
    p += numberAt(text, p) || 1;
    if (++k % DIGIT_PIECE === 0 && p < to) yield [p, false];
  }
}

/**
 * The places text is cut for counting, in order: where a word ends, and inside a stretch with no such place that is
 * longer than a word can be (stretchPlaces).
 */
export function* cutPlaces(text: string): Generator<[at: number, must: boolean]> {
  let last = 0;
  // Three bytes at most to a UTF-16 unit: a stretch of no more than a third of LONGEST_WORD units is never long.
  const long = (to: number) => to - last > LONGEST_WORD / 3 && utf8Bytes(text, last, to, LONGEST_WORD) > LONGEST_WORD;
  for (const m of text.matchAll(WORD_END)) {
    if (long(m.index!)) yield* stretchPlaces(text, last, m.index!);
    yield [m.index!, false];
    last = m.index!;
  }
  if (long(text.length)) yield* stretchPlaces(text, last, text.length);
}

/**
 * Where text may be cut for a passage to begin: not between the two halves of a character, and not inside a group of
 * three digits in a run cut into pieces (`c`, stretchPlaces), whose pieces the passage would group otherwise than they
 * were counted. (Inside a run that is one piece, the part of it is counted as it is.) The returned function gives the
 * nearest such place at or before `at` (with `later`, at or after it). Read once: for every step of a search, a run of
 * 30,000 digits was read back to where it began.
 */
function cutter(text: string, c: Counted): (at: number, later?: boolean) => number {
  // For each place between two digits, how many digits of its run come before it, of three: 0 where a group begins.
  let phase: Uint8Array | null = null;
  if (/\p{N}/u.test(text)) {
    phase = new Uint8Array(text.length + 1);
    for (let i = 0, k = 0; i < text.length; ) {
      const n = numberAt(text, i);
      k = n > 0 ? k + 1 : 0;
      i += n || 1;
      phase[i] = k % 3;
    }
  }
  // Whether the piece `at` is in ends between two digits: it is a piece of a run cut into pieces.
  const cutRun = (at: number) => {
    const end = c.starts[partAt(c, at) + 1];
    return end < text.length && numberBefore(text, end) > 0 && numberAt(text, end) > 0;
  };
  return (at, later = false) => {
    if (splitsPair(text, at)) at += later ? 1 : -1;
    if (phase && phase[at] > 0 && numberAt(text, at) > 0 && cutRun(at)) {
      for (let r = phase[at]; r > 0 && r < 3; r += later ? 1 : -1) at += later ? numberAt(text, at) : -numberBefore(text, at);
    }
    return at;
  };
}

/**
 * Tokens of the pieces met while one document is cut. A piece is met again and again (every passage is counted more
 * than once, a word recurs, a long run of one character is cut into many equal pieces), and is given to the
 * tokenizer once. Up to PARTS_KEPT pieces are kept, then they are let go and kept again from none: a document of 4 MB
 * of words not seen before (650,000 pieces) kept them all, 40 MB, and one of 50 MB would keep ten times that. (Pieces
 * let go are counted again when they are met again: such a document is cut in twice the time.)
 */
let seenParts: Map<string, number> | null = null;
const PARTS_KEPT = 250_000;

/**
 * A copy of a part that holds only its own characters. A part is a slice of the text it was cut from, and V8 keeps a
 * slice of 13 characters or more as a pointer into that text: kept here or in the tokenizer's cache, it kept the
 * whole document alive (4 MB a document, 233 MB after 60 logs). Joined to a space, the part is copied whole; the copy
 * without the space points into the copy only.
 */
const own = (part: string): string => (part.length >= 13 ? ` ${part}`.slice(1) : part);

/** Tokens of text the tokenizer is given whole: a piece between two cut places, or a part of one. */
function tokensOf(part: string): number {
  let n = seenParts?.get(part);
  if (n === undefined) {
    charsGiven += part.length;
    if (++partsGiven > TOKENIZER_PARTS || charsGiven > TOKENIZER_CHARS) {
      clearMergeCache();
      partsGiven = charsGiven = 0;
    }
    const copy = own(part);
    n = encode(copy, AS_TEXT).length;
    if (seenParts) {
      if (seenParts.size >= PARTS_KEPT) seenParts.clear();
      seenParts.set(copy, n);
    }
  }
  return n;
}

/**
 * Tokens in text (gpt-tokenizer's default encoding), counted piece by piece between cut places: the same total as
 * whole for prose, and no less than whole for a stretch cut by force. With `stop`, counting ends once there are more
 * than that: what is over a cap is not counted to its end.
 */
function countTokens(text: string, stop = Infinity): number {
  let n = 0;
  let start = 0;
  for (const [at, must] of cutPlaces(text)) {
    n += tokensOf(text.slice(start, at)) + (must ? marginAt(text, at) : 0);
    start = at;
    if (n > stop) return n;
  }
  return n + tokensOf(text.slice(start));
}

/**
 * Where the last place in text is at which the tokenizer always ends a token, or 0 when there is none. Only places from
 * `from` on are looked at (each place depends on the character before it and the one after it only).
 */
function lastWordEnd(text: string, from = 1): number {
  for (let i = text.length - 1; i >= Math.max(1, from); i--) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff && i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff) continue;
    WORD_END_AT.lastIndex = i;
    if (WORD_END_AT.test(text)) return i;
  }
  return 0;
}

/**
 * The tokens of a passage built up one piece after another (sentences, paragraphs, rows, small sections), counted as
 * the passage is stored: with picture addresses taken out (extractImages), and without the white space at its ends.
 * What lies before the last word end is counted once and kept as a number, so that a passage that grows one paragraph
 * at a time is not counted again from its start every time.
 *
 * A stretch with no word end in it is counted at the places stretchPlaces cuts it at, as countTokens counts it, once it
 * is longer than a word can be, or once it runs on past one piece added (paragraphs of nothing but "/" and other
 * signs, table rows of nothing but "|" and "-" after spaces: no prose does). The pieces whose places can no longer
 * change are counted then and kept as a number too. Kept as text, such a stretch was read again from its start for
 * every paragraph added: 66,000 paragraphs of "/" took nine seconds at 4,000 tokens a passage.
 */
class Joined {
  private settled = 0;
  /** What comes after the last place counted: a word end, or a place in a stretch cut by force. */
  private tail = '';
  /** The tail is part of a stretch with no word end that is counted in pieces cut by force. */
  private forced = false;
  constructor(first: string) {
    this.add(first);
  }
  /** What follows the places counted once `more` is added, as stored (white space before the passage begins goes). */
  private next(more: string): string {
    const t = this.tail + stored(more);
    return this.settled === 0 && this.tail === '' ? t.trimStart() : t;
  }
  /**
   * Whether the passage with `more` after it is within max tokens, as stored. A token is at least one byte: when the
   * bytes are within what is left, the text is not read (a passage of paragraphs of "/" was read again for each one).
   */
  fits(more: string, max: number): boolean {
    const t = this.next(more).trimEnd();
    const left = max - this.settled;
    return utf8Bytes(t, 0, t.length, left) <= left || countTokens(t, left) <= left;
  }
  add(more: string): void {
    const from = this.tail.length;
    let t = this.next(more);
    const end = lastWordEnd(t, from);
    if (end > 0) {
      this.settled += countTokens(t.slice(0, end));
      t = t.slice(end);
      this.forced = false;
    } else if (from > 0) {
      this.forced = true;
    }
    if (!this.forced && t.length > LONGEST_WORD / 3 && utf8Bytes(t, 0, t.length, LONGEST_WORD) > LONGEST_WORD) this.forced = true;
    if (this.forced) {
      // A place cut by force is settled once the characters its margin is read from (WORD_PIECE + 1 after it) are
      // there; a place between groups of digits is exact.
      let at = 0;
      for (const [place, must] of stretchPlaces(t, 0, t.length)) {
        if (must && place + WORD_PIECE + 1 > t.length) break;
        this.settled += tokensOf(t.slice(at, place)) + (must ? marginAt(t, place) : 0);
        at = place;
      }
      t = t.slice(at);
    }
    this.tail = t;
  }
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

/** Text as a passage of it is stored: picture addresses taken out, and no half of a character left alone. */
function stored(text: string): string {
  return stripLoneSurrogates(text.includes('![') ? extractImages(text).content : text);
}

/**
 * Number of markdown tables in the chunk, approximated by counting `|---|` separator rows: a run of lines made of
 * nothing but "|", ":", "-" and white space, with a line that begins with "|" and one that ends with "|", counts once
 * (an empty row `| | |` next to the separator is part of the same table). Line by line: the pattern this replaced let
 * \s run across lines, and every line of a run of blank lines read the whole run.
 */
export function countTables(content: string): number {
  let tables = 0;
  // In the run of such lines being read: where its first "|" that begins a line is, and its last "|" that ends one.
  let first = -1;
  let last = -1;
  const close = () => {
    if (first >= 0 && last >= first + 2) tables++;
    first = last = -1;
  };
  let at = 0;
  for (const line of content.split(/[\n\u2028\u2029]/)) {
    if (!/^[\s:|-]*$/.test(line)) close();
    else {
      const lead = line.length - line.trimStart().length;
      if (first < 0 && line[lead] === '|') first = at + lead;
      const end = line.trimEnd().length;
      if (end > 0 && line[end - 1] === '|') last = at + end - 1;
    }
    at += line.length + 1;
  }
  close();
  return tables;
}

/** Whether the text is a markdown table block (70% or more of the rows have the |...| form). */
function isTableBlock(text: string): boolean {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return false;
  const pipeLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  return pipeLines >= lines.length * 0.7;
}

/**
 * Splits a large table by row and prepends the header (first row + separator) to each piece (keeps column names).
 * A piece ends when the next row would take it over the cap, counted as the piece would be; a row too large for a
 * piece of its own is cut by characters.
 */
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
  let joined = new Joined(header);
  for (const row of bodyRows) {
    const rt = countTokens(row);
    if ((bufTok + rt > maxTokens || !joined.fits(`\n${row}`, maxTokens)) && buf.length > 1) {
      out.push(buf.join('\n'));
      buf = [header, row];
      bufTok = headerTok + rt;
      joined = new Joined(header);
    } else {
      buf.push(row);
      bufTok += rt;
    }
    joined.add(`\n${row}`);
  }
  if (buf.length > 1) out.push(buf.join('\n'));
  return (out.length > 0 ? out : [table]).flatMap((piece) => (countTokens(piece.trim(), maxTokens) > maxTokens ? hardCutByChars(piece, maxTokens) : [piece]));
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

/** Text in its pieces (between cut places) with the tokens of each, so that any stretch of it is counted piece by piece. */
interface Counted {
  text: string;
  /** Where each piece begins, then the end of the text. */
  starts: number[];
  /** Tokens of each piece, with the margin of a cut by force at its end (PIECE_MARGIN). */
  tokens: number[];
  /** That margin. */
  margin: number[];
  /** before[i]: the tokens of the pieces before piece i. */
  before: number[];
  /** The piece begins or ends where a long stretch was cut by force. */
  piece: boolean[];
}

function counted(text: string): Counted {
  const c: Counted = { text, starts: [0], tokens: [], margin: [], before: [0], piece: [] };
  let start = 0;
  let forcedStart = false;
  const add = (end: number, forced: boolean) => {
    const m = forced ? marginAt(text, end) : 0;
    const n = tokensOf(text.slice(start, end)) + m;
    c.margin.push(m);
    c.tokens.push(n);
    c.before.push(c.before[c.before.length - 1] + n);
    c.starts.push(end);
    c.piece.push(forcedStart || forced);
    forcedStart = forced;
    start = end;
  };
  for (const [at, must] of cutPlaces(text)) add(at, must);
  add(text.length, false);
  return c;
}

/** The piece that holds the character at `at`. */
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
 * What the searches of one document may still spend on giving the tokenizer parts of pieces, in squared characters
 * (the tokenizer's work on a piece grows with its square). Each step of a search that ends inside a piece counts that
 * part exactly, which keeps a cut where it always was; a document of long words in every cut (random letters with
 * no space or punctuation for a hundred characters) took two seconds that way at 100 tokens a passage. Past this,
 * the rest of the document is searched with parts taken in proportion, and each cut is still checked exactly.
 */
let searchWork = 0;
const SEARCH_WORK_PER_CHAR = 64;

/**
 * Whether text.slice(from, to) is within max tokens, counted as countTokens counts it. The whole pieces in it are
 * added up; a piece it cuts at either end is given to the tokenizer only when the sum leaves the answer open (a UTF-16
 * unit is at most three bytes, so at most three tokens). With `estimate` (a step of a search), a part of a piece cut by
 * force, or of any piece once searchWork is spent, is taken in proportion to its length instead; the cut the search
 * finds is checked exactly.
 */
function fits(c: Counted, from: number, to: number, max: number, estimate = false): boolean {
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
  // A piece cut at its start keeps the margin of a forced cut at its end.
  const margin = (k: number, b: number) => (b === c.starts[k + 1] ? c.margin[k] : 0);
  if (ends.reduce((most, [k, a, b]) => most + 3 * (b - a) + margin(k, b), n) <= max) return true;
  for (const [k, a, b] of ends) {
    const whole = c.starts[k + 1] - c.starts[k];
    if (estimate && (c.piece[k] || searchWork <= 0)) {
      n += Math.ceil(((c.tokens[k] - margin(k, c.starts[k + 1])) * (b - a)) / whole) + PIECE_MARGIN;
    } else {
      if (estimate) searchWork -= (b - a) * (b - a);
      n += tokensOf(c.text.slice(a, b));
    }
    n += margin(k, b);
  }
  return n <= max;
}

/**
 * Hard cut by characters (last resort when even a sentence exceeds the cap).
 * A binary search finds the longest prefix within maxTokens. The text is counted once, in pieces (counted); a step of
 * the search adds up pieces and gives the tokenizer only the piece it ends in. (Counting the whole rest again for
 * every cut and every step took minutes on 100 KB.)
 *
 * A piece is within maxTokens as it is, and also without the white space at its ends, as it is stored when it begins
 * or ends a passage (a passage is trimmed). " encyclopedia" is one token and "encyclopedia" three: counted only with
 * the space before it, a piece of a Russian sentence with no end came to four tokens over the cap once trimmed.
 */
function hardCutByChars(text: string, maxTokens: number): string[] {
  const c = counted(text);
  // Where the white space that ends at each place begins, and where the white space that begins there ends (read once:
  // read again at every step, a run of 200,000 spaces was read hundreds of times).
  const spaceFrom = new Int32Array(text.length + 1);
  const spaceTo = new Int32Array(text.length + 1);
  for (let i = 1; i <= text.length; i++) spaceFrom[i] = SPACE.test(text[i - 1]) ? spaceFrom[i - 1] : i;
  spaceTo[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i--) spaceTo[i] = SPACE.test(text[i]) ? spaceTo[i + 1] : i;
  let at = 0;
  let from = spaceTo[0];
  const cutAt = cutter(text, c);
  // Where a piece that begins at `at` can end at or before `to` (cutter): after `at`, or else just after `to`.
  const place = (to: number) => {
    if (to >= text.length) return text.length;
    const end = cutAt(to);
    return end > at ? end : cutAt(to, true);
  };
  const within = (to: number, estimate = false) => {
    const p = place(to);
    const end = Math.max(from, spaceFrom[p]);
    return fits(c, at, p, maxTokens, estimate) && ((from === at && end === p) || fits(c, from, end, maxTokens, estimate));
  };
  if (within(text.length)) return [text];
  const out: string[] = [];
  while (at < text.length) {
    from = spaceTo[at];
    if (within(text.length)) {
      out.push(text.slice(at));
      break;
    }
    let lo = 1;
    let hi = text.length - at;
    let cut = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (within(at + mid, true)) {
        cut = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Inside a stretch that is not prose, the cut goes where its pieces begin: the rest then begins where they do,
    // and is counted from the same pieces again instead of new ones. Then it is checked exactly, and moved back while
    // what it leaves holds too much (a piece taken in proportion can hold more than its share).
    // (So does any cut once the document's search work is spent: a cut at the start of a piece needs no part of it
    // counted to be checked.)
    const j = partAt(c, at + cut);
    if ((c.piece[j] || searchWork <= 0) && c.starts[j] > from && c.starts[j] < at + cut) cut = c.starts[j] - at;
    if (!within(at + cut)) cut = longestFitting(c, at, cut, within);
    const end = place(at + cut);
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * After an estimate placed a cut too far: the longest beginning, shorter than `cut`, that is within the cap counted
 * exactly (`within`). Searched from where the piece the cut fell in begins, which is nearly always within it.
 */
function longestFitting(c: Counted, at: number, cut: number, within: (to: number) => boolean): number {
  let lo = Math.max(1, c.starts[partAt(c, at + cut - 1)] - at);
  if (lo >= cut || !within(at + lo)) lo = 1;
  let hi = cut - 1;
  let best = lo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (within(at + mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The suffix of text that fits in the last maxTokens tokens (for the overlap, binary search, counted as above). It
 * begins where a passage may (cutter): an emoji cut in half lost both halves, and digits begun inside a group were
 * grouped otherwise than counted.
 */
function tailByTokens(text: string, maxTokens: number): string {
  const c = counted(text);
  if (fits(c, 0, text.length, maxTokens)) return text;
  const cutAt = cutter(text, c);
  const start = (at: number) => cutAt(at, true);
  const within = (at: number, estimate = false) => fits(c, start(at), text.length, maxTokens, estimate);
  let lo = 0;
  let hi = text.length - 1;
  let cut = text.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (within(mid, true)) {
      cut = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  // Checked exactly. Moved on while it holds too much: to where the next piece begins inside a stretch that is not
  // prose, otherwise to the nearest start within the piece that fits.
  if (!within(cut)) {
    const k = partAt(c, cut);
    let lo = cut + 1;
    let hi = Math.min(text.length - 1, c.starts[k + 1]);
    if (c.piece[k] || !within(hi)) {
      while (cut < text.length - 1 && !within(cut)) cut = c.starts[partAt(c, cut) + 1] ?? cut + 1;
    } else {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (within(mid)) {
          cut = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
    }
  }
  return text.slice(Math.min(start(cut), text.length));
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
  let joined: Joined | null = null; // the unit being packed, as it will be counted (once it is asked for)
  const flush = () => {
    if (buf.length > 0) {
      out.push(buf.join(' '));
      buf = [];
      bufTokens = 0;
      joined = null;
    }
  };

  for (const sentence of splitSentences(text)) {
    const st = countTokens(sentence, maxTokens);
    if (st > maxTokens) {
      flush();
      out.push(...hardCutByChars(sentence, maxTokens));
      continue;
    }
    // Packed by the sum of the sentences, as before, and never past the cap once they are joined.
    if (buf.length > 0 && (bufTokens + st > maxTokens || !(joined ??= new Joined(buf.join(' '))).fits(` ${sentence}`, maxTokens))) flush();
    joined?.add(` ${sentence}`);
    buf.push(sentence);
    bufTokens += st;
  }
  flush();
  return out;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const SPACE = /\s/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * A heading line ("## Title"): its level and text, or null. What /^(#{1,6})\s+(.+)$/ took, read once from the left: that
 * pattern tried every split of the spaces after the marks between its two parts, and a line of 50,000 spaces took
 * a second.
 */
export function headingOf(line: string): { level: number; text: string } | null {
  let level = 0;
  while (line.charCodeAt(level) === 35) level++; // "#"
  if (level < 1 || level > 6) return null;
  let at = level;
  while (at < line.length && SPACE.test(line[at])) at++;
  if (at === level) return null;
  const rest = line.slice(at);
  if (rest) return LINE_BREAK.test(rest) ? null : { level, text: rest.trim() };
  // Nothing but white space after the marks: the last of it is the text, unless it ends a line.
  return at - level >= 2 && !LINE_BREAK.test(line[at - 1]) ? { level, text: '' } : null;
}

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
    } else if (fence === null && buf.length > 0 && headingOf(line)) {
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
  return headingOf(section.split('\n', 1)[0]);
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
  searchWork = SEARCH_WORK_PER_CHAR * markdown.length + 1_000_000;
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

  const out: RawChunk[] = [];
  // The passage before, as stored with its own overlap: the overlap of the next one comes from its end (and reaches
  // into the overlap of the one before when it is short, as it always has).
  let before = '';
  /**
   * A passage made final: its picture addresses separated, its metadata taken from its own content (taken after the
   * overlap, the passage before's pictures and code would leak into it), the overlap put before it, and counted. Each
   * is made final as soon as the next passage is not joined to it, while its pieces are still in seenParts: made final
   * all at the end, a document large enough for seenParts to be let go was counted again from its start, and took two
   * to three times as long.
   */
  const finish = (c: PreChunk) => {
    const { content: imgStripped, image_urls } = extractImages(c.content);
    // Trimmed again: a picture with no text at an end of the passage leaves white space there, and the passage was
    // counted without it.
    const kept = stripLoneSurrogates(imgStripped).trim();
    // The overlap is a suffix with picture addresses already taken out. Strip lone surrogates once more on the whole
    // (an embedding service or Qdrant answers 400 to one).
    const overlap = before && OVERLAP_TOKENS > 0 ? tailByTokens(before, OVERLAP_TOKENS) : '';
    before = overlap ? `…${overlap}\n\n${kept}` : kept;
    const content = stripLoneSurrogates(before);
    out.push({ heading: c.heading, content, tokens: countTokens(content), image_urls, table_count: countTables(c.content), has_code_block: /```/.test(c.content), ...docMeta });
  };
  // Chunks under MIN_TOKENS are joined to the one before, unless that would take it over the cap: 4,000 short
  // sections in a row made one passage of 62,000 tokens, more than an embedding model takes.
  let pending: (PreChunk & { joined?: Joined }) | null = null;
  const emit = (c: PreChunk) => {
    if (c.tokens < MIN_TOKENS && pending && (pending.joined ??= new Joined(pending.content)).fits(`\n\n${c.content}`, MAX_TOKENS)) {
      pending.content = `${pending.content}\n\n${c.content}`;
      pending.tokens += c.tokens;
      pending.joined.add(`\n\n${c.content}`);
    } else {
      if (pending) finish(pending);
      pending = { ...c };
    }
  };

  // "windows": the document is one run of paragraphs. Headings stay in the text and are not cut at.
  const sections = profile.cut === 'windows' ? [body] : splitSections(body);
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

    // Kept whole when it is within the cap as before, and as it is stored (trimmed: "!;" can be more tokens than
    // "!;\n", and a word more without the space before it; and without picture addresses).
    const content = section.trim();
    const kept = stored(content).trim();
    const tokens = countTokens(section, MAX_TOKENS);
    if (tokens <= MAX_TOKENS && (kept === section || countTokens(kept, MAX_TOKENS) <= MAX_TOKENS)) {
      emit({ heading: currentHeading, content, tokens });
      continue;
    }

    const paragraphs = splitParagraphs(section).flatMap((p) =>
      countTokens(p, HARD_MAX_TOKENS) > HARD_MAX_TOKENS ? splitLongText(p, HARD_MAX_TOKENS) : [p],
    );
    let buf: string[] = [];
    let bufTokens = 0;
    let joined: Joined | null = null; // the passage being packed, as it will be counted (once it is asked for)
    for (const para of paragraphs) {
      const pt = countTokens(para);
      // Packed by the sum of the paragraphs, as before, and never past the cap once they are joined.
      if (buf.length > 0 && (bufTokens + pt > MAX_TOKENS || !(joined ??= new Joined(buf.join('\n\n'))).fits(`\n\n${para}`, MAX_TOKENS))) {
        emit({ heading: currentHeading, content: buf.join('\n\n').trim(), tokens: bufTokens });
        buf = [];
        bufTokens = 0;
        joined = null;
      }
      joined?.add(`\n\n${para}`);
      buf.push(para);
      bufTokens += pt;
    }
    if (buf.length > 0) {
      emit({ heading: currentHeading, content: buf.join('\n\n').trim(), tokens: bufTokens });
    }
  }
  if (pending) finish(pending);
  return out;
}

