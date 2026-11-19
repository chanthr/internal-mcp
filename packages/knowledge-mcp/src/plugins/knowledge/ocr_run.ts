/**
 * Reading the scanned files of the local folders with the OCR that is set (drive/ocr.ts).
 *
 * A folder scan never reads a scan itself: it counts the files with no text and moves on, so a folder of thousands
 * of PDFs is searchable in minutes. Reading the scans is this separate run, started from the console (or after
 * every scan, when the OCR runs on this computer and the person turned that on). It reads one file at a time,
 * says how far it is down to the page, can be stopped, and keeps what it read (drive/ocr.ts), so nothing is read
 * twice while a file is unchanged.
 */
import { extractLocalFile } from '../drive/extract_text.js';
import { backfillVectors, indexText } from '../drive/indexer.js';
import { ocrConfigured } from '../drive/ocr.js';
import { readByOcr, resolveLocalId, waitingForOcr } from './folders.js';

export interface OcrRun {
  running: boolean;
  /** Files looked at, of the files this run takes. */
  done: number;
  total: number;
  current: string | null;
  /** Pages of the file being read. */
  page: { done: number; total: number } | null;
  /** Files read and indexed, and their pages. */
  read: number;
  pages: number;
  /** Files read in which nothing was found. */
  empty: number;
  failed: Array<{ name: string; why: string }>;
  /** Why it ended early, in a sentence. */
  stopped: string | null;
  startedAt: number;
  endedAt: number | null;
}
let current: (OcrRun & { stop: AbortController }) | null = null;

export function ocrRun(): OcrRun | null {
  if (!current) return null;
  const { stop: _stop, ...view } = current;
  return { ...view, page: view.page ? { ...view.page } : null, failed: [...view.failed] };
}
export function ocrWaiting(): number {
  return waitingForOcr().length;
}

/** Read up to `limit` of the waiting files. Returns at once; the page reads how far it is. */
export function startOcrRun(opts: { limit?: number; afterRead?: () => void } = {}): OcrRun {
  if (current?.running) return ocrRun()!;
  if (!ocrConfigured()) throw new Error('No OCR is set. Set one up first.');
  const ids = waitingForOcr().slice(0, opts.limit ?? Infinity);
  const run: NonNullable<typeof current> = { running: true, done: 0, total: ids.length, current: null, page: null, read: 0, pages: 0, empty: 0, failed: [], stopped: null, startedAt: Date.now(), endedAt: null, stop: new AbortController() };
  current = run;
  void (async () => {
    for (const id of ids) {
      if (run.stop.signal.aborted) break;
      const file = await resolveLocalId(id);
      if (!file) {
        readByOcr(id); // gone, or no longer a document here
        run.done++;
        continue;
      }
      run.current = file.path;
      run.page = null;
      try {
        const r = await extractLocalFile(file.abs, file.mimeType, { ocr: true, signal: run.stop.signal, onPage: (done, total) => (run.page = { done, total }) });
        if (r.needsOcr || !r.text.trim()) run.empty++;
        else {
          await indexText({ id: file.id, name: file.name, path: file.path, modifiedTime: file.modifiedTime, source: file.folder.source, mimeType: file.mimeType, size: file.size }, r.text, undefined, { vectors: false });
          run.read++;
          run.pages += Number(r.meta?.pages ?? 0) || 1;
        }
        readByOcr(id);
      } catch (e) {
        if (run.stop.signal.aborted) break;
        run.failed.push({ name: file.path, why: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        // The OCR itself is down (not this one file): the rest would fail the same way.
        if (run.failed.length >= 3 && run.read === 0) {
          run.stopped = 'Stopped after three files failed in a row.';
          break;
        }
      }
      run.done++;
    }
    if (run.stop.signal.aborted && !run.stopped) run.stopped = 'Stopped.';
    run.running = false;
    run.current = null;
    run.page = null;
    run.endedAt = Date.now();
    // The text is in; vectors are made from it the usual way, when a model is set.
    void backfillVectors().catch(() => undefined);
    if (run.read) opts.afterRead?.();
  })();
  return ocrRun()!;
}

export function stopOcrRun(): void {
  current?.stop.abort();
}
