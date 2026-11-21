/**
 * Reading the scanned files of the local folders with the OCR that is set (drive/ocr.ts).
 *
 * A folder scan never reads a scan itself: it counts the files with no text and moves on, so a folder of thousands
 * of PDFs is searchable in minutes. Reading the scans is this separate run, started from the console (or after
 * every scan, when the OCR runs on this computer and the person turned that on). It reads one file at a time,
 * says how far it is down to the page, can be stopped, and keeps what it read (drive/ocr.ts), so nothing is read
 * twice while a file is unchanged.
 *
 * A file that failed (one page the model could not read fails the whole file) stays waiting. A run started from the
 * console tries it again; a run that starts by itself after a pass leaves it alone once it failed AUTO_TRIES times
 * as it is now, instead of reading up to 200 pages of it again after every pass. A file that changes is tried again.
 *
 * Only a failure that is the file's counts: the OCR answered, and could not read it. An OCR that cannot be used
 * (not running, too slow, broken for a moment, a model it does not have: drive/ocr.ts) fails every file, and a run
 * that could read nothing at all, not one page, does not tell a bad file from a bad OCR: neither is held against
 * the files. What was held against them is let go once the OCR reads something again, or is changed.
 */
import { extractLocalFile } from '../drive/extract_text.js';
import { backfillVectors, indexText } from '../drive/indexer.js';
import { ocrBy, ocrConfigured, ocrIsLocal, ocrSettings, ocrUnavailable } from '../drive/ocr.js';
import { noTextSince, readByOcr, resolveLocalId, waitingForOcr } from './folders.js';

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

const AUTO_TRIES = 3;
/**
 * Files whose reading failed: how often, at which modified time, with which OCR. Only waiting files are kept, so it
 * stays small.
 */
const failures = new Map<string, { modified: string; by: string; tries: number }>();
const ocrNow = (): string => {
  const s = ocrSettings();
  return s ? ocrBy(s) : '';
};
const givenUp = (id: string): boolean => {
  const f = failures.get(id);
  return !!f && f.tries >= AUTO_TRIES && f.modified === noTextSince(id) && f.by === ocrNow();
};

export function ocrRun(): OcrRun | null {
  if (!current) return null;
  const { stop: _stop, ...view } = current;
  return { ...view, page: view.page ? { ...view.page } : null, failed: [...view.failed] };
}
export function ocrWaiting(): number {
  return waitingForOcr().length;
}

/**
 * After a folder pass: read what waits, when the OCR runs on this computer and the person turned that on, except
 * the files that failed AUTO_TRIES times as they are now. Null when there is nothing to start.
 */
export function startAutoOcrRun(): OcrRun | null {
  if (process.env.OCR_AUTO?.trim() !== 'true' || !ocrIsLocal() || current?.running) return null;
  const waiting = waitingForOcr();
  const still = new Set(waiting);
  for (const id of failures.keys()) if (!still.has(id)) failures.delete(id);
  const due = waiting.filter((id) => !givenUp(id));
  return due.length ? startOcrRun({ ids: due }) : null;
}

/** Read up to `limit` of the waiting files (or the files named). Returns at once; the page reads how far it is. */
export function startOcrRun(opts: { limit?: number; ids?: string[]; afterRead?: () => void } = {}): OcrRun {
  if (current?.running) return ocrRun()!;
  if (!ocrConfigured()) throw new Error('No OCR is set. Set one up first.');
  const ids = (opts.ids ?? waitingForOcr()).slice(0, opts.limit ?? Infinity);
  const run: NonNullable<typeof current> = { running: true, done: 0, total: ids.length, current: null, page: null, read: 0, pages: 0, empty: 0, failed: [], stopped: null, startedAt: Date.now(), endedAt: null, stop: new AbortController() };
  current = run;
  // The files that failed by their own fault in this run (id → modified time), and whether the OCR read any page.
  const faults = new Map<string, string>();
  let answered = false;
  void (async () => {
    for (const id of ids) {
      if (run.stop.signal.aborted) break;
      const file = await resolveLocalId(id);
      if (!file) {
        readByOcr(id); // gone, or no longer a document here
        failures.delete(id);
        run.done++;
        continue;
      }
      run.current = file.path;
      run.page = null;
      try {
        const r = await extractLocalFile(file.abs, file.mimeType, {
          ocr: true,
          signal: run.stop.signal,
          onPage: (done, total) => {
            run.page = { done, total };
            if (done > 0) answered = true; // a page was read
          },
        });
        if (r.needsOcr || !r.text.trim()) run.empty++;
        else {
          await indexText({ id: file.id, name: file.name, path: file.path, modifiedTime: file.modifiedTime, source: file.folder.source, mimeType: file.mimeType, size: file.size }, r.text, undefined, { vectors: false });
          run.read++;
          run.pages += Number(r.meta?.pages ?? 0) || 1;
        }
        readByOcr(id);
        failures.delete(id);
      } catch (e) {
        if (run.stop.signal.aborted) break;
        run.failed.push({ name: file.path, why: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        if (!ocrUnavailable(e)) faults.set(id, file.modifiedTime);
        // The OCR itself is down (not this one file): the rest would fail the same way.
        if (run.failed.length >= 3 && run.read === 0) {
          run.stopped = 'Stopped after three files failed in a row.';
          break;
        }
      }
      run.done++;
    }
    if (run.stop.signal.aborted && !run.stopped) run.stopped = 'Stopped.';
    // The OCR read something: what was held against files before (perhaps while it was half broken) is let go.
    if (run.read > 0) failures.clear();
    if (run.read > 0 || answered) {
      const by = ocrNow();
      for (const [id, modified] of faults) {
        const before = failures.get(id);
        failures.set(id, { modified, by, tries: before?.modified === modified && before.by === by ? before.tries + 1 : 1 });
      }
    }
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
