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
 * definitions, and puts the alt text in place of the references to them and of inline `![alt](data:image/...)`, as
 * the chunker does for a picture with an address. Pictures with a real address (`![alt](https://...)`) are kept.
 *
 * With `written` (a Markdown or text file someone wrote): a picture whose data is less than LARGE_PICTURE characters
 * (a dot, an icon, an example in code) is kept, and costs little to index; a larger one is dropped wherever it is, as
 * from a Google Doc. One of 1.6 MB became 374 passages of letters. Code is not looked for: a picture of 1 MB in a
 * numbered step, indented as code is, was taken for code, kept and cut into 855 passages.
 */
export function stripEmbeddedImages(text: string, opts: { written?: boolean } = {}): string {
  if (!text || !/data:image\//i.test(text)) return text;
  return dropPictures(text, opts.written ? LARGE_PICTURE : 0);
}

/** A picture of data written into a Markdown or text file is dropped when its data has this many characters. */
const LARGE_PICTURE = 1024;

/**
 * The start of a data address for a picture, up to the comma its data follows: any type, parameters such as
 * ";charset=utf-8" or ";name=a.png", and ";base64" or not, in any case (an SVG as ";charset=utf-8;base64,", or as
 * ";utf8," and URL-encoded, was kept whole). Each parameter begins with ";", which nothing inside one matches, so it is
 * read once.
 */
const DATA_IMAGE = String.raw`data:image\/[\w.+-]+(?:;[\w.+-]+(?:=[^;,)>\s]*)?)*,`;
/**
 * A definition line and nothing else (an optional title may follow): `[label]: <data:image/...>` or `[label]:
 * data:image/...`. A line with other words after it is a paragraph, not a definition, and stays.
 */
const DEFINITION = new RegExp(String.raw`^[ \t]*\[([^\]\n]+)\]:[ \t]*(?:<${DATA_IMAGE}([^>\n]*)>|${DATA_IMAGE}(\S*))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*(?:\n|$)`, 'gim');
/** A reference to a definition: `![alt][label]`. */
const REFERENCE = /!\[([^[\]\n]*)\]\[([^[\]\n]+)\]/g;
/**
 * An inline picture of data: `![alt](data:image/...)`. Its data may run over lines (base64 is often broken every 76
 * characters). It does not read past the next "[" or ")": a line of "![" over and over was read to its end from every
 * one of them. Base64 has neither in it.
 */
const INLINE = new RegExp(String.raw`!\[([^[\]\n]*)\]\(\s*<?${DATA_IMAGE}([^)[]*)\)`, 'gi');

/** A label as CommonMark matches it: in any case, white space taken as one space. */
const label = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Pictures of data in text whose data has at least `least` characters: definitions go, and references to them and
 * inline pictures become their alt text.
 */
function dropPictures(text: string, least: number): string {
  const labels = new Set<string>();
  let t = text.replace(DEFINITION, (m, name: string, bracketed: string | undefined, bare: string | undefined) => {
    if ((bracketed ?? bare ?? '').length < least) return m;
    labels.add(label(name));
    return '';
  });
  if (labels.size > 0) t = t.replace(REFERENCE, (m, alt: string, name: string) => (labels.has(label(name)) ? alt : m));
  t = t.replace(INLINE, (m, alt: string, data: string) => (data.length < least ? m : alt));
  // A file someone wrote with nothing dropped is left as it is.
  return least > 0 && t === text ? text : t.replace(/\n{3,}/g, '\n\n');
}
