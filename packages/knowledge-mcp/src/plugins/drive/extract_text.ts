/**
 * Text extraction router by document format. Preprocessing for vector indexing.
 *
 * Free extraction (no OCR needed):
 *   - text/markdown, text/plain      → as is
 *   - Google Docs                    → Drive export text/markdown
 *   - Google Sheets                  → Drive export text/csv
 *   - Google Slides                  → Drive export text/plain
 *   - Word .docx                     → ooxml.ts (paragraph text from the XML inside the zip)
 *   - PDF (digital)                  → pdf-parse (text layer)
 *
 * OCR needed (follow-up step, Mathpix):
 *   - PDF (scanned, too little text) → Mathpix
 *   - .pptx / image                  → Mathpix / Gemini multimodal
 *
 * Lazy imports (pdf-parse, xlsx): loaded only when needed.
 */
import type { DriveClient } from './client.js';
import { cleanExtractedText, stripEmbeddedImages } from './clean_text.js';

export interface ExtractResult {
  text: string;
  method: string;
  needsOcr?: boolean; // pdf-parse found too little text → a candidate for the Mathpix follow-up
  meta?: Record<string, unknown>;
}

/** Threshold for detecting a scan: average characters per page */
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

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A workbook as text: one "## <tab name>" section per tab, rows as CSV. Empty tabs are left out. */
export async function workbookText(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map((n) => ({ n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n]).trim() }))
    .filter((s) => s.csv)
    .map((s) => `## ${s.n}\n${s.csv}`)
    .join('\n\n');
}

async function exportGoogle(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const r = await drive.files.export({ fileId, mimeType }, { responseType: 'text' });
  return r.data as unknown as string;
}

/** Extraction + cleaning (noise cleanup). Entry point for indexing and search. */
/**
 * With opts.ocr=false, files that need OCR (scanned PDFs, images) are not sent to Mathpix and are returned with needsOcr.
 * The same applies when there is no Mathpix key. Previously this threw, was counted as a reindex failure, and the
 * checkpoint was never cleared.
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

/** Raw extraction per format (before cleaning). */
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

  // 2. Google Workspace: Drive export (free)
  if (mimeType === 'application/vnd.google-apps.document') {
    return { text: stripEmbeddedImages(await exportGoogle(drive, fileId, 'text/markdown')), method: 'gdoc→md' };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    // CSV export only carries the first tab. Export the workbook and read every tab, like an uploaded .xlsx.
    const r = await drive.files.export({ fileId, mimeType: XLSX_MIME }, { responseType: 'arraybuffer' });
    return { text: await workbookText(Buffer.from(r.data as ArrayBuffer)), method: 'gsheet→xlsx' };
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return { text: await exportGoogle(drive, fileId, 'text/plain'), method: 'gslide→txt' };
  }

  // 3. Word .docx: dependency-free zip/XML reading (ooxml.ts). Blank line between paragraphs, the same shape as the former
  // mammoth extractRawText output
  if (mimeType.includes('wordprocessingml')) {
    const { docxText } = await import('./ooxml.js');
    const buffer = await downloadBuffer(drive, fileId);
    return { text: docxText(buffer), method: 'docx→ooxml' };
  }

  // 4. PDF: pdf-parse v2. Digital text. Scans (<MIN) fall back to Mathpix OCR
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
    // Scan → Mathpix OCR (only when a key is present and OCR is allowed)
    if (!ocr) return { text, method: 'pdf-parse (scanned, OCR off)', needsOcr: true, meta: { pages, charsPerPage: Math.round(charsPerPage) } };
    const { mathpixPdfToMarkdown } = await import('./mathpix.js');
    const md = await mathpixPdfToMarkdown(buffer);
    return {
      text: md,
      method: 'pdf→mathpix-ocr',
      meta: { pages, charsPerPage: Math.round(charsPerPage), ocr: true },
    };
  }

  // 5. PowerPoint .pptx → "## Slide N" + body + speaker notes for each slide (ooxml.ts)
  if (mimeType.includes('presentationml')) {
    const { pptxText } = await import('./ooxml.js');
    const buffer = await downloadBuffer(drive, fileId);
    return { text: pptxText(buffer), method: 'pptx→ooxml' };
  }

  // 6. Excel .xlsx → SheetJS (csv per sheet)
  if (mimeType.includes('spreadsheetml')) {
    return { text: await workbookText(await downloadBuffer(drive, fileId)), method: 'xlsx→sheetjs' };
  }

  // 7. Image → Mathpix OCR (v3/text, immediate)
  if (mimeType.startsWith('image/')) {
    if (!ocr) return { text: '', method: 'image (OCR off)', needsOcr: true };
    const buffer = await downloadBuffer(drive, fileId);
    const { mathpixImageToMarkdown } = await import('./mathpix.js');
    const md = await mathpixImageToMarkdown(buffer, mimeType);
    return { text: md, method: 'image→mathpix' };
  }

  // 8. Unsupported
  return { text: '', method: `unsupported:${mimeType}`, needsOcr: true };
}
