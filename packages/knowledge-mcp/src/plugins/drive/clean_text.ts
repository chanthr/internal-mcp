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
 */
export function cleanExtractedText(text: string): string {
  if (!text) return '';
  let t = text;

  // 1. Image markdown (![alt](url)) is not removed. The chunker separates it into image_urls and keeps it.

  // 2. LaTeX wrapper — \title{X} \section{X} \subsection{X} → X
  t = t.replace(/\\(?:title|section|subsection|textbf|textit)\s*\{([^}]*)\}/g, '$1');

  // 3. HTML <br> → newline. For the other tags, keep the text and remove only the tag
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 4. Remove pdf-parse page markers (-- 1 of 22 --)
  t = t.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '');

  // 5. Restore some HTML entities
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // 6. Normalize trailing spaces and excess blank lines
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Drop picture data embedded in a document. A Google Doc exported as Markdown appends every picture as a definition
 * line (`[image1]: <data:image/png;base64,...>`) and leaves a reference (`![][image1]`) in the text. Removes those
 * definitions, the references to them, and inline `![alt](data:image/...)`. Pictures with a real address
 * (`![alt](https://...)`) are kept.
 */
export function stripEmbeddedImages(text: string): string {
  if (!text || !text.includes('data:image/')) return text;
  const labels = new Set<string>();
  let t = text.replace(
    /^[ \t]*\[([^\]\n]+)\]:[ \t]*<?data:image\/[a-zA-Z0-9.+-]+;base64,[^\n]*\n?/gm,
    (_m, label: string) => {
      labels.add(label);
      return '';
    },
  );
  if (labels.size > 0) {
    t = t.replace(/!\[[^\]\n]*\]\[([^\]\n]+)\]/g, (m, label: string) => (labels.has(label) ? '' : m));
  }
  t = t.replace(/!\[[^\]\n]*\]\(<?data:image\/[a-zA-Z0-9.+-]+;base64,[^)\n]*\)/g, '');
  return t.replace(/\n{3,}/g, '\n\n');
}
