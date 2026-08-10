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
