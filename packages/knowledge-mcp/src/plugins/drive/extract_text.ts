/**
 * 문서 형식별 텍스트 추출 router. 벡터 색인 전처리.
 *
 * 무료 추출 (OCR 불필요):
 *   - text/markdown, text/plain      → 그대로
 *   - Google Docs                    → Drive export text/markdown
 *   - Google Sheets                  → Drive export text/csv
 *   - Google Slides                  → Drive export text/plain
 *   - Word .docx                     → ooxml.ts (zip 안 XML 의 문단 텍스트)
 *   - PDF (digital)                  → pdf-parse (텍스트 레이어)
 *
 * OCR 필요 (후속 — Mathpix):
 *   - PDF (스캔본, 텍스트 부족)        → Mathpix
 *   - .pptx / image                  → Mathpix / Gemini multimodal
 *
 * lazy import (pdf-parse, xlsx) — 필요 시에만 로드.
 */
import type { DriveClient } from './client.js';
import { cleanExtractedText } from './clean_text.js';

export interface ExtractResult {
  text: string;
  method: string;
  needsOcr?: boolean; // pdf-parse 가 텍스트 부족 판정 → 후속 Mathpix 대상
  meta?: Record<string, unknown>;
}

/** 스캔본 판정 threshold — 페이지당 평균 글자 수 */
const MIN_CHARS_PER_PAGE = 80;

async function downloadText(drive: DriveClient, fileId: string): Promise<string> {
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return r.data as unknown as string;
}

async function downloadBuffer(drive: DriveClient, fileId: string): Promise<Buffer> {
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(r.data as ArrayBuffer);
}

async function exportGoogle(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const r = await drive.files.export({ fileId, mimeType }, { responseType: 'text' });
  return r.data as unknown as string;
}

/** 추출 + 정제 (노이즈 cleanup). 색인·검색 진입점. */
/**
 * opts.ocr=false 면 OCR 이 필요한 파일(스캔 PDF, 이미지)을 Mathpix 로 보내지 않고 needsOcr 로 돌려준다.
 * Mathpix 키가 없을 때도 같다 — 예전엔 throw 해서 재색인 실패로 셌고, 체크포인트가 지워지지 않았다.
 */
export async function extractText(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
  opts: { ocr?: boolean } = {},
): Promise<ExtractResult> {
  const { mathpixConfigured } = await import('./mathpix.js');
  const raw = await extractRaw(drive, fileId, mimeType, opts.ocr !== false && mathpixConfigured());
  return { ...raw, text: cleanExtractedText(raw.text) };
}

/** 형식별 원본 추출 (정제 전). */
async function extractRaw(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
  ocr: boolean,
): Promise<ExtractResult> {
  // 1. Native text
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') {
    return { text: await downloadText(drive, fileId), method: 'native' };
  }

  // 2. Google Workspace — Drive export (무료)
  if (mimeType === 'application/vnd.google-apps.document') {
    return { text: await exportGoogle(drive, fileId, 'text/markdown'), method: 'gdoc→md' };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return { text: await exportGoogle(drive, fileId, 'text/csv'), method: 'gsheet→csv' };
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return { text: await exportGoogle(drive, fileId, 'text/plain'), method: 'gslide→txt' };
  }

  // 3. Word .docx — 의존성 없는 zip/XML 읽기 (ooxml.ts). 문단 사이 빈 줄 — 예전 mammoth extractRawText 와 같은 모양
  if (mimeType.includes('wordprocessingml')) {
    const { docxText } = await import('./ooxml.js');
    const buffer = await downloadBuffer(drive, fileId);
    return { text: docxText(buffer), method: 'docx→ooxml' };
  }

  // 4. PDF — pdf-parse v2. digital 텍스트, 스캔본(<MIN) 은 Mathpix OCR fallback
  if (mimeType === 'application/pdf') {
    const buffer = await downloadBuffer(drive, fileId);
    const { PDFParse } = (await import('pdf-parse')) as any;
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    let text = '';
    let pages = 1;
    try {
      const result = await parser.getText();
      text = result.text ?? '';
      pages = result.total ?? 1;
    } finally {
      await parser.destroy();
    }
    const charsPerPage = text.replace(/\s/g, '').length / Math.max(pages, 1);
    if (charsPerPage >= MIN_CHARS_PER_PAGE) {
      return { text, method: 'pdf-parse', meta: { pages, charsPerPage: Math.round(charsPerPage) } };
    }
    // 스캔본 → Mathpix OCR (키가 있고 OCR 을 허용한 경우만)
    if (!ocr) return { text, method: 'pdf-parse (scanned, OCR off)', needsOcr: true, meta: { pages, charsPerPage: Math.round(charsPerPage) } };
    const { mathpixPdfToMarkdown } = await import('./mathpix.js');
    const md = await mathpixPdfToMarkdown(buffer);
    return {
      text: md,
      method: 'pdf→mathpix-ocr',
      meta: { pages, charsPerPage: Math.round(charsPerPage), ocr: true },
    };
  }

  // 5. PowerPoint .pptx → 슬라이드마다 "## Slide N" + 본문 + 발표자 노트 (ooxml.ts)
  if (mimeType.includes('presentationml')) {
    const { pptxText } = await import('./ooxml.js');
    const buffer = await downloadBuffer(drive, fileId);
    return { text: pptxText(buffer), method: 'pptx→ooxml' };
  }

  // 6. Excel .xlsx → SheetJS (시트별 csv)
  if (mimeType.includes('spreadsheetml')) {
    const XLSX = await import('xlsx');
    const buffer = await downloadBuffer(drive, fileId);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const text = wb.SheetNames.map(
      (n) => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`,
    ).join('\n\n');
    return { text, method: 'xlsx→sheetjs' };
  }

  // 7. 이미지 → Mathpix OCR (v3/text, 즉시)
  if (mimeType.startsWith('image/')) {
    if (!ocr) return { text: '', method: 'image (OCR off)', needsOcr: true };
    const buffer = await downloadBuffer(drive, fileId);
    const { mathpixImageToMarkdown } = await import('./mathpix.js');
    const md = await mathpixImageToMarkdown(buffer, mimeType);
    return { text: md, method: 'image→mathpix' };
  }

  // 8. 미지원
  return { text: '', method: `unsupported:${mimeType}`, needsOcr: true };
}
