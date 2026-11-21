/**
 * Cleans extracted text: removes extractor noise for better embedding and search quality.
 *
 * Conservative rules only (to avoid damaging the meaning):
 *   - image markdown ![](url)        → kept (the chunker moves it to image_urls)
 *   - LaTeX wrapper (\title{}, \section{}) → only the content is kept
 *   - HTML tags (<div>, <br>, <span>...)  → the text is kept, only the tags are removed
 *   - pdf-parse page marker (-- N of M --) → removed
 *   - excess blank lines, trailing spaces → normalized
 *
 * Math delimiters ($...$) are kept (they may be real formulas). Tables (| ... |) are kept.
 *
 * Every pattern here runs on text anyone can send (a note to POST /inbox, a file in a folder), so none may try a long
 * stretch again from every place it starts: one note of blank lines or spaces held the server for 17 to 98 seconds.
 * Nothing matches across lines unless it has to, and what a match may span is bounded by the next place another one
 * could start.
 */
// White space within one line: \s without the characters that end a line.
const INLINE_SPACE = String.raw`[^\S\r\n\u2028\u2029]`;
const PAGE_MARKER = new RegExp(String.raw`^${INLINE_SPACE}*--${INLINE_SPACE}*\d+${INLINE_SPACE}+of${INLINE_SPACE}+\d+${INLINE_SPACE}*--${INLINE_SPACE}*$`, 'gim');

export function cleanExtractedText(text: string): string {
  if (!text) return '';
  let t = text;

  // 1. Image markdown (![alt](url)) is not removed. The chunker separates it into image_urls and keeps it.

  // 2. LaTeX wrapper — \title{X} \section{X} \subsection{X} → X. What is inside is bounded: without a closing brace,
  //    every "\section{" read on to the end of the text.
  t = t.replace(/\\(?:title|section|subsection|textbf|textit)\s*\{([^}]{0,1000})\}/g, '$1');

  // 3. HTML <br> → newline. For the other tags, keep the text and remove only the tag. A tag ends before the next "<",
  //    so "x<y " written over and over is not read to the end from every "<".
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?[a-zA-Z][^<>]*>/g, '');

  // 4. Remove pdf-parse page markers (-- 1 of 22 --). Only white space within the line: \s crossed lines, and every
  //    line of a run of blank lines read the whole run.
  t = t.replace(PAGE_MARKER, '');

  // 5. Restore some HTML entities
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // 6. Normalize trailing spaces and excess blank lines. A run of spaces is tried from its first space only: tried
  //    from each, a run with no line break after it was read again from every space in it.
  t = t.replace(/(?<![ \t])[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Drop picture data embedded in a document. A Google Doc exported as Markdown appends every picture as a definition
 * line (`[image1]: <data:image/png;base64,...>`) and leaves a reference (`![][image1]`) in the text. Removes those
 * definitions, the references to them, and inline `![alt](data:image/...)`. Pictures with a real address
 * (`![alt](https://...)`) are kept.
 *
 * With `written` (a Markdown or text file someone wrote): what is inside a code block or `inline code` is an example
 * and is kept as it is, and so is a picture of less than LARGE_PICTURE characters (a dot, an icon), which costs
 * little to index. A picture of real size is dropped as from a Google Doc: one of 1.6 MB became 374 passages of letters.
 * Code is found as CommonMark finds it: a block fenced with ``` or ~~~, a block indented by four spaces after a blank
 * line, and inline code from a run of backticks to the next run as long, over the lines of its paragraph.
 */
export function stripEmbeddedImages(text: string, opts: { written?: boolean } = {}): string {
  if (!text || !text.includes('data:image/')) return text;
  if (!opts.written) return dropPictures(text, 0);
  const lines = text.split('\n');
  const block = codeBlocks(lines);
  // Where inline code is in each line of a paragraph that holds a picture of data: [from, to) pairs.
  const spans: Array<Array<[number, number]>> = lines.map(() => []);
  for (let i = 0; i < lines.length; ) {
    if (block[i] || BLANK.test(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !block[j] && !BLANK.test(lines[j])) j++;
    const paragraph = lines.slice(i, j).join('\n');
    if (paragraph.includes('data:image/')) {
      let line = i;
      let start = 0; // where that line begins in the paragraph
      for (const [from, to] of inlineCode(paragraph)) {
        while (from >= start + lines[line].length + 1) start += lines[line++].length + 1;
        // A span over several lines is cut at their ends.
        for (let k = line, s = start; k < j && s < to; s += lines[k++].length + 1) spans[k].push([Math.max(from, s) - s, Math.min(to, s + lines[k].length) - s]);
      }
    }
    i = j;
  }
  // Definitions first (a reference can come before its definition), then references and inline pictures.
  const labels = new Set<string>();
  const kept: number[] = [];
  lines.forEach((line, i) => {
    const m = block[i] || line.length < LARGE_PICTURE || inside(spans[i], line.length - line.trimStart().length) ? null : DEFINITION.exec(line);
    if (m) labels.add(m[1]);
    else kept.push(i);
  });
  const out = kept.map((i) => (block[i] || !lines[i].includes('![') ? lines[i] : outside(lines[i], spans[i], (part) => dropInline(part, labels, LARGE_PICTURE))));
  const joined = out.join('\n');
  return joined === text ? text : joined.replace(/\n{3,}/g, '\n\n');
}

/** A picture of data, of at least this many characters, written into a Markdown or text file is dropped. */
const LARGE_PICTURE = 1024;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const BLANK = /^[ \t\r]*$/;
const DEFINITION = /^[ \t]*\[([^\]\n]+)\]:[ \t]*<?data:image\/[a-zA-Z0-9.+-]+;base64,/;
/** The text of a picture of data, up to where its data begins. */
const PICTURE_ALT = /!\[([^[\]\n]*)\]\(<?data:image\//g;

/**
 * Which lines are code blocks: fenced with ``` or ~~~ (closed as CommonMark closes them), or indented by four columns
 * where a paragraph cannot go on (after a blank line, a heading, a fence or another such line).
 */
function codeBlocks(lines: string[]): boolean[] {
  const code: boolean[] = [];
  let fence: string | null = null;
  // The line before may be followed by an indented code block.
  let open = true;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      code.push(true);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) {
        fence = null;
        open = true;
      }
    } else if (f) {
      code.push(true);
      fence = f[1];
    } else if (BLANK.test(line)) {
      code.push(false);
      open = true;
    } else if (open && indent(line) >= 4) {
      code.push(true);
    } else {
      code.push(false);
      open = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);
    }
  }
  return code;
}

/** Columns of white space a line begins with (a tab goes on to the next multiple of four). */
function indent(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
    if (n >= 4) break;
  }
  return n;
}

/**
 * Inline code in a paragraph, as [from, to) pairs that take in the backticks: from a run of backticks to the next run
 * of as many, or none when there is no such run. A backtick in the text of a picture of data does not begin or end
 * one (`![a \`b](data:...) and \`x\`` is a picture). Each run is looked at once: the next run of each length is
 * kept as a place in a list of runs of that length.
 */
function inlineCode(paragraph: string): Array<[number, number]> {
  const alt: Array<[number, number]> = [];
  for (const m of paragraph.matchAll(PICTURE_ALT)) alt.push([m.index! + 2, m.index! + 2 + m[1].length]);
  const runs: Array<[at: number, length: number]> = [];
  let a = 0;
  for (let i = 0; i < paragraph.length; ) {
    if (paragraph.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (paragraph.charCodeAt(j) === 96) j++;
    while (a < alt.length && alt[a][1] <= i) a++;
    if (!(a < alt.length && alt[a][0] <= i)) runs.push([i, j - i]);
    i = j;
  }
  const byLength = new Map<number, number[]>();
  runs.forEach(([, n], k) => {
    const same = byLength.get(n);
    if (same) same.push(k);
    else byLength.set(n, [k]);
  });
  const next = new Map<number, number>(); // for each length, where in its list the runs not yet passed begin
  const spans: Array<[number, number]> = [];
  for (let k = 0; k < runs.length; k++) {
    const [at, n] = runs[k];
    if (spans.length > 0 && at < spans[spans.length - 1][1]) continue;
    const same = byLength.get(n)!;
    let p = next.get(n) ?? 0;
    while (p < same.length && same[p] <= k) p++;
    next.set(n, p);
    if (p < same.length) spans.push([at, runs[same[p]][0] + n]);
  }
  return spans;
}

/** Whether `at` is in one of the [from, to) pairs. */
function inside(spans: Array<[number, number]>, at: number): boolean {
  return spans.some(([from, to]) => at >= from && at < to);
}

/** `f` applied to the parts of a line outside the [from, to) pairs, which are in order. */
function outside(line: string, spans: Array<[number, number]>, f: (part: string) => string): string {
  let out = '';
  let at = 0;
  for (const [from, to] of spans) {
    out += f(line.slice(at, from)) + line.slice(from, to);
    at = to;
  }
  return out + f(line.slice(at));
}

/** Every picture of data in text: definitions, references to them and inline pictures. */
function dropPictures(text: string, least: number): string {
  const labels = new Set<string>();
  const t = text.replace(/^[ \t]*\[([^\]\n]+)\]:[ \t]*<?data:image\/[a-zA-Z0-9.+-]+;base64,[^\n]*\n?/gm, (m, label: string) => {
    if (m.length < least) return m;
    labels.add(label);
    return '';
  });
  return dropInline(t, labels, least).replace(/\n{3,}/g, '\n\n');
}

/**
 * References to dropped definitions, and inline pictures of data of at least `least` characters. A reference or a
 * picture does not read past the next "[": a line of "![" over and over was read to its end from every one of them.
 * Base64 has no "[" in it.
 */
function dropInline(text: string, labels: Set<string>, least: number): string {
  let t = text;
  if (labels.size > 0) t = t.replace(/!\[[^[\]\n]*\]\[([^[\]\n]+)\]/g, (m, label: string) => (labels.has(label) ? '' : m));
  return t.replace(/!\[[^[\]\n]*\]\(<?data:image\/[a-zA-Z0-9.+-]+;base64,[^)[\n]*\)/g, (m) => (m.length < least ? m : ''));
}

