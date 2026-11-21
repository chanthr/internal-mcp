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
 * OCR needed (ocr.ts: a vision model, or Mathpix):
 *   - PDF (scanned, too little text) → each page drawn and read
 *   - image                          → read
 *
 * Lazy imports (pdf-parse, xlsx): loaded only when needed.
 */
import type { DriveClient } from './client.js';
import { keepOcr, keptOcr, ocrBy, ocrConfigured, ocrImage, ocrPdf, ocrSettings } from './ocr.js';
import { cleanExtractedText, stripEmbeddedImages } from './clean_text.js';

export interface ExtractResult {
  text: string;
  method: string;
  needsOcr?: boolean; // pdf-parse found too little text → a candidate for OCR (ocr.ts)
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

/** Rows read from one tab. */
const SHEET_ROWS = 100_000;
/** Cells written out from one workbook, filled or empty, over all its tabs. */
const WORKBOOK_CELLS = 2_000_000;
/**
 * Characters of CSV written out from one workbook, as SheetJS writes them (quotes and commas included). Cells can
 * share one text of up to 32,767 characters: a workbook of 44 KB whose 3,000 cells all held the same one became 98 MB
 * of text, and quotes are written twice (300 cells of 32,767 quotes: 19.7 million characters, counted as 9.8).
 */
const WORKBOOK_CHARS = 10_000_000;

/**
 * Characters of one row as CSV: each cell as SheetJS writes it (in quotes, with its quotes doubled, when it holds a
 * comma, a quote or a line break), a comma between cells, a line break after. Read no further than just past `most`.
 */
function csvRowLength(row: Array<Cell | undefined>, from: number, to: number, most: number): number {
  let n = to - from + 1;
  for (const k of Object.keys(row)) {
    const cell = row[Number(k)];
    if (!cell || Number(k) < from || Number(k) > to) continue;
    const text = cell.v != null ? (cell.w ?? String(cell.v)) : cell.f != null ? `=${cell.f}` : '';
    let quotes = 0;
    let quoted = false;
    for (let i = 0; i < text.length && n + i <= most; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) quotes++;
      if (c === 34 || c === 44 || c === 10) quoted = true;
    }
    n += text.length + (quoted ? quotes + 2 : 0);
    if (n > most) break;
  }
  return n;
}

type Cell = import('xlsx').CellObject;

/**
 * A workbook as text: one "## <tab name>" section per tab, rows as CSV. Empty tabs and empty rows are left out.
 *
 * A tab is written over the range it says it has (its <dimension>), as before, when that is no larger than what is
 * left of WORKBOOK_CELLS; a larger one is not believed (a file of 1.5 KB with one cell said 200,000 rows by 100
 * columns and became 20 million commas, and one that says a million rows by 16,384 columns would have run for an
 * hour), and the range comes from the cells that are there. Only rows that hold a cell are visited, and what is
 * written over all tabs stops at WORKBOOK_CELLS cells or WORKBOOK_CHARS characters of cell text: a workbook of 1,000
 * tabs with two cells far apart took 12 seconds. Where reading stops, a line says so. Other work is let in between
 * tabs.
 */
export async function workbookText(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  // One row more than is read: whether it is there says whether the tab has more.
  const wb = XLSX.read(buffer, { type: 'buffer', dense: true, sheetRows: SHEET_ROWS + 1 });
  let left = WORKBOOK_CELLS;
  let chars = WORKBOOK_CHARS;
  const notRead = (name: string) =>
    `## ${name}\n(Not read: the workbook holds more than is read, ${WORKBOOK_CELLS.toLocaleString('en-US')} cells or ${WORKBOOK_CHARS.toLocaleString('en-US')} characters.)`;
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    await new Promise((resolve) => setImmediate(resolve));
    const ws = wb.Sheets[name];
    const ref = ws?.['!ref'];
    const data = (ws?.['!data'] ?? []) as Array<Array<Cell | undefined> | undefined>;
    if (!ws || !ref) continue;
    // The rows that hold a cell, and where the cells are. A dense sheet has holes where there are none; its keys are
    // the rows and cells that are there (walking the indexes visited every empty row: 100,000 per tab).
    const rows: number[] = [];
    let more = false;
    let first = Infinity;
    let last = -1;
    for (const key of Object.keys(data)) {
      const r = Number(key);
      const row = data[r];
      if (!Number.isInteger(r) || !row) continue;
      if (r >= SHEET_ROWS) {
        more = true;
        continue;
      }
      let any = false;
      for (const k of Object.keys(row)) {
        const col = Number(k);
        if (!Number.isInteger(col) || !row[col]) continue;
        any = true;
        first = Math.min(first, col);
        last = Math.max(last, col);
      }
      if (any) rows.push(r);
    }
    if (rows.length === 0) continue;
    // Rows past SHEET_ROWS + 1 are not kept, and a tab that says it has more (SheetJS keeps what it says in !fullref)
    // may have them: row 100,002 with row 100,001 empty was dropped without a word. What a tab says is believed only
    // when its rows run to the last that is read: a tab of 10 rows that said 200,000 got the note.
    if (ws['!fullref'] && rows[rows.length - 1] >= SHEET_ROWS - 1) more = true;
    if (left <= 0 || chars <= 0) {
      out.push(notRead(name));
      continue;
    }
    const said = XLSX.utils.decode_range(ref);
    const believed = (said.e.r - said.s.r + 1) * (said.e.c - said.s.c + 1) <= left;
    // Columns from where the tab says it begins when that is not after its first cell, as before.
    const from = believed || said.s.c <= first ? said.s.c : first;
    const to = believed ? said.e.c : last;
    const width = to - from + 1;
    const taken: Array<Array<Cell | undefined>> = [];
    let stopped = false;
    let lastRow = 0;
    for (const r of rows) {
      if (believed && (r < said.s.r || r > said.e.r)) continue;
      const size = width > left ? Infinity : csvRowLength(data[r]!, from, to, chars);
      if (size > chars) {
        stopped = true;
        break;
      }
      left -= width;
      chars -= size;
      taken.push(data[r]!);
      lastRow = r + 1;
    }
    if (taken.length === 0) {
      out.push(notRead(name));
      continue;
    }
    // Written by SheetJS from the rows taken only, one after another: rows without a cell are not visited.
    const compact = { '!data': taken, '!ref': XLSX.utils.encode_range({ s: { r: 0, c: from }, e: { r: taken.length - 1, c: to } }) } as unknown as import('xlsx').WorkSheet;
    const csv = XLSX.utils.sheet_to_csv(compact, { blankrows: false }).trim();
    const note = stopped || more ? `\n(Only rows up to ${(stopped ? lastRow : SHEET_ROWS).toLocaleString('en-US')} are read.)` : '';
    if (csv) out.push(`## ${name}\n${csv}${note}`);
  }
  return out.join('\n\n');
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
 * With opts.ocr=false, files that need OCR (scanned PDFs, images) are not read and are returned with needsOcr.
 * The same applies when no OCR is set (ocr.ts). Previously this threw, was counted as a reindex failure, and the
 * checkpoint was never cleared.
 */
export async function extractText(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
  opts: { ocr?: boolean } = {},
): Promise<ExtractResult> {
  const raw = await extractRaw(drive, fileId, mimeType, opts.ocr !== false && ocrConfigured());
  return { ...raw, text: cleanExtractedText(raw.text) };
}

/** Where a file's bytes come from: a Drive download, or a file on disk. Each is read at most once, when needed. */
interface ByteSource {
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
}

/** Raw extraction per format (before cleaning). */
async function extractRaw(
  drive: DriveClient,
  fileId: string,
  mimeType: string,
  ocr: boolean,
): Promise<ExtractResult> {
  // Google Workspace: Drive export (free)
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

  return extractBytes(mimeType, { text: () => downloadText(drive, fileId), buffer: () => downloadBuffer(drive, fileId) }, ocr);
}

/** How a scan is read: stopped from outside, and how far it is (a long scan takes minutes). */
export interface OcrProgress {
  signal?: AbortSignal;
  onPage?: (done: number, total: number) => void;
}
/** The most pages read from one scan. A 500-page scan is read in part, and the text says how much was left out. */
const OCR_MAX_PAGES = Math.max(1, Number(process.env.OCR_MAX_PAGES ?? 200) || 200);

/** Extraction for formats that are plain files: text, Word, PDF, PowerPoint, Excel, images. */
async function extractBytes(mimeType: string, src: ByteSource, ocr: boolean, progress: OcrProgress = {}): Promise<ExtractResult> {
  // 1. Native text. Pictures embedded as base64 are dropped (not small ones, and not examples in code): a Markdown
  //    file with one picture of 1.6 MB took 7.5 seconds to cut and became 374 passages of letters for the embedding model.
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') {
    return { text: stripEmbeddedImages(await src.text(), { written: true }), method: 'native' };
  }

  // 3. Word .docx: dependency-free zip/XML reading (ooxml.ts). Blank line between paragraphs, the same shape as the former
  // mammoth extractRawText output
  if (mimeType.includes('wordprocessingml')) {
    const { docxText } = await import('./ooxml.js');
    const buffer = await src.buffer();
    return { text: docxText(buffer), method: 'docx→ooxml' };
  }

  // 4. PDF: pdf-parse v2. Digital text. Scans (<MIN) fall back to Mathpix OCR
  if (mimeType === 'application/pdf') {
    const buffer = await src.buffer();
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
    // Scan → OCR (only when one is set and OCR is allowed here)
    const s = ocr ? ocrSettings() : null;
    if (!s) return { text, method: 'pdf-parse (scanned, OCR off)', needsOcr: true, meta: { pages, charsPerPage: Math.round(charsPerPage) } };
    const read = await ocrPdf(buffer, s, { maxPages: OCR_MAX_PAGES, ...progress });
    return {
      text: read.text,
      method: s.kind === 'mathpix' ? 'pdf→mathpix-ocr' : `pdf→ocr (${s.model})`,
      meta: { pages, charsPerPage: Math.round(charsPerPage), ocr: true },
    };
  }

  // 5. PowerPoint .pptx → "## Slide N" + body + speaker notes for each slide (ooxml.ts)
  if (mimeType.includes('presentationml')) {
    const { pptxText } = await import('./ooxml.js');
    const buffer = await src.buffer();
    return { text: pptxText(buffer), method: 'pptx→ooxml' };
  }

  // 6. Excel .xlsx → SheetJS (csv per sheet)
  if (mimeType.includes('spreadsheetml')) {
    return { text: await workbookText(await src.buffer()), method: 'xlsx→sheetjs' };
  }

  // 7. Image → OCR
  if (mimeType.startsWith('image/')) {
    const s = ocr ? ocrSettings() : null;
    if (!s) return { text: '', method: 'image (OCR off)', needsOcr: true };
    const text = await ocrImage(await src.buffer(), mimeType, s, progress.signal);
    return { text, method: s.kind === 'mathpix' ? 'image→mathpix' : `image→ocr (${s.model})`, meta: { pages: 1, ocr: true } };
  }

  // 8. Unsupported
  return { text: '', method: `unsupported:${mimeType}`, needsOcr: true };
}

/** File extension → the MIME type the extractor understands. Extensions not listed are not indexed. */
const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Images are documents only when OCR is set: without it there is nothing to read in them. */
const IMAGE_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The MIME type for a local file name, or null when the format is not supported. */
export function mimeForFileName(name: string): string | null {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? (ocrConfigured() ? (IMAGE_BY_EXTENSION[ext] ?? null) : null);
}

/**
 * Extraction + cleaning for a file on disk (local folder sources). OCR is off unless asked for: a folder scan must
 * never start a paid job on its own.
 */
export async function extractLocalFile(path: string, mimeType: string, opts: { ocr?: boolean } & OcrProgress = {}): Promise<ExtractResult> {
  const { readFile, stat } = await import('node:fs/promises');
  // A scan read before is not read again while the file is unchanged: that took minutes, or was billed.
  const info = await stat(path);
  const stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
  const kept = keptOcr(path, stamp);
  const s = ocrSettings();
  const raw = await extractBytes(mimeType, { text: () => readFile(path, 'utf8'), buffer: () => readFile(path) }, opts.ocr === true && !!s && !kept, opts);
  if (raw.needsOcr && kept) return { text: cleanExtractedText(kept.text), method: `ocr (kept, ${kept.by})`, meta: { pages: kept.pages, ocr: true } };
  if (raw.meta?.ocr && s) keepOcr(path, { stamp, by: ocrBy(s), text: raw.text, pages: Number(raw.meta.pages ?? 0) });
  return { ...raw, text: cleanExtractedText(raw.text) };
}
