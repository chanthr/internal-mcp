/**
 * 추출 텍스트 정제 — 임베딩/검색 품질을 위해 추출기 노이즈 제거.
 *
 * 보수적 규칙만 (의미 손상 방지):
 *   - 이미지 markdown ![](url)        → 보존 (chunker 가 image_urls 로 분리. 2026-05-27 RAG 개선)
 *   - LaTeX wrapper (\title{}, \section{}) → 내용만 보존
 *   - HTML 태그 (<div>, <br>, <span>...)  → 텍스트 보존하고 태그만 제거
 *   - pdf-parse 페이지 마커 (-- N of M --) → 제거
 *   - 과도한 빈 줄·줄끝 공백          → 정규화
 *
 * 수식 delimiter($...$) 는 보존 (실제 수식 가능성). 표(| ... |) 보존.
 */
export function cleanExtractedText(text: string): string {
  if (!text) return '';
  let t = text;

  // 1. 이미지 markdown(![alt](url)) 은 제거하지 않음 — chunker 가 image_urls 로 분리 보존 (2026-05-27)

  // 2. LaTeX wrapper — \title{X} \section{X} \subsection{X} → X
  t = t.replace(/\\(?:title|section|subsection|textbf|textit)\s*\{([^}]*)\}/g, '$1');

  // 3. HTML <br> → 개행, 나머지 태그는 텍스트 보존하고 태그만 제거
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 4. pdf-parse 페이지 마커 (-- 1 of 22 --) 제거
  t = t.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '');

  // 5. HTML entity 일부 복원
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // 6. 줄끝 공백 + 과도한 빈 줄 정규화
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
