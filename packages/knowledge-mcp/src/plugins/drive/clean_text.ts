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
 */
export function stripEmbeddedImages(text: string, opts: { written?: boolean } = {}): string {
  if (!text || !text.includes('data:image/')) return text;
  if (!opts.written) return dropPictures(text, 0);
  // Line by line, so that code blocks can be told apart (``` or ~~~, closed as CommonMark closes them).
  const lines = text.split('\n');
  const code: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence === null) {
      code.push(!!f);
      if (f) fence = f[1];
    } else {
      code.push(true);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
    }
  }
  // Definitions first (a reference can come before its definition), then references and inline pictures.
  const labels = new Set<string>();
  const kept: Array<{ line: string; code: boolean }> = [];
  lines.forEach((line, i) => {
    const m = code[i] || line.length < LARGE_PICTURE ? null : DEFINITION.exec(line);
    if (m) labels.add(m[1]);
    else kept.push({ line, code: code[i] });
  });
  const out = kept.map(({ line, code: inCode }) => (inCode || !line.includes('![') ? line : outsideInlineCode(line, (part) => dropInline(part, labels, LARGE_PICTURE))));
  const joined = out.join('\n');
  return joined === text ? text : joined.replace(/\n{3,}/g, '\n\n');
}

/** A picture of data, of at least this many characters, written into a Markdown or text file is dropped. */
const LARGE_PICTURE = 1024;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DEFINITION = /^[ \t]*\[([^\]\n]+)\]:[ \t]*<?data:image\/[a-zA-Z0-9.+-]+;base64,/;

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

/** `f` applied to the parts of a line outside `inline code` (from a backtick to the next one). */
function outsideInlineCode(line: string, f: (part: string) => string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = line.indexOf('`', at);
    const close = open < 0 ? -1 : line.indexOf('`', open + 1);
    if (close < 0) return out + f(line.slice(at));
    out += f(line.slice(at, open)) + line.slice(open, close + 1);
    at = close + 1;
  }
}
