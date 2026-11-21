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
 * Only a failure that is the file's counts. The OCR answered and refused it (an image it cannot take, a page it
 * cannot read): always. It was too slow, or answered with a server error: only when it read other pages in the same
 * run, or reads its test page right after (drive/ocr.ts), since then it works and the file is what it cannot do. Not
 * reached at all, or set up wrong: never. A file that failed is put at the back of the next run, so that files it
 * can read are read first. What was held against a file is let go when the file changes, when another OCR is set,
 * or when the file is read (a run started from the console).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { extractLocalFile } from '../drive/extract_text.js';
import { backfillVectors, indexText } from '../drive/indexer.js';
import { checkOcr, ocrBy, ocrConfigured, ocrIsLocal, ocrSettings, ocrUnavailable, type OcrUnavailable } from '../drive/ocr.js';
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
/**
 * The files that failed in the last run, unless the OCR could not be reached or was set up wrong: with the files
 * that have failed before, the next run that starts by itself takes them last, so that a file that fails (or stops
 * the OCR) does not keep the files behind it from being read.
 */
let failedLast = new Set<string>();
/** How long to wait before asking the OCR for its test page a second time (it may be starting again). A test shortens it. */
export const ocrRecheck: { ms: number } = { ms: 3_000 };

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
  const last = (id: string): number => Number(failures.has(id) || failedLast.has(id));
  due.sort((a, b) => last(a) - last(b));
  return due.length ? startOcrRun({ ids: due }) : null;
}

/** Read up to `limit` of the waiting files (or the files named). Returns at once; the page reads how far it is. */
export function startOcrRun(opts: { limit?: number; ids?: string[]; afterRead?: () => void } = {}): OcrRun {
  if (current?.running) return ocrRun()!;
  if (!ocrConfigured()) throw new Error('No OCR is set. Set one up first.');
  const ids = (opts.ids ?? waitingForOcr()).slice(0, opts.limit ?? Infinity);
  const run: NonNullable<typeof current> = { running: true, done: 0, total: ids.length, current: null, page: null, read: 0, pages: 0, empty: 0, failed: [], stopped: null, startedAt: Date.now(), endedAt: null, stop: new AbortController() };
  current = run;
  // The files that failed in this run (id → modified time, and why when it may not be the file's fault), and
  // whether the OCR read any page.
  const faults = new Map<string, { modified: string; why: OcrUnavailable | null; after: boolean }>();
  // A server error right after another one may only follow from it (the file before brought the OCR down): it is
  // not held against the file it happened to.
  let afterError = false;
  let answered = false;
  // Failures that may be the OCR's (too slow, a server error) with nothing read yet: three of them, and it is down.
  let down = 0;
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
        afterError = false;
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
        const why = ocrUnavailable(e);
        faults.set(id, { modified: file.modifiedTime, why, after: !!why && afterError });
        afterError = !!why;
        // The OCR itself is down, or set up wrong (not this one file): the rest would fail the same way. A file it
        // refused says nothing about the next one.
        if (why === 'unreachable' || why === 'setup') {
          run.stopped = why === 'unreachable' ? 'Stopped: the OCR could not be reached.' : 'Stopped: the OCR is not set up right.';
          break;
        }
        if (why && ++down >= 3 && run.read === 0 && !answered) {
          run.stopped = 'Stopped after three files failed in a row.';
          break;
        }
      }
      run.done++;
    }
    failedLast = new Set([...faults].filter(([, f]) => f.why !== 'unreachable' && f.why !== 'setup' && !f.after).map(([id]) => id));
    // Too slow, or a server error (also a connection it dropped): the file's fault if the OCR works. It read pages in
    // this run, or else its test page is put to it (on this computer, where nothing is billed), and once more a
    // moment later when the file brought it down and it is starting again. Stop stops that too.
    const doubtful = [...faults.values()].some((f) => f.why === 'slow' || f.why === 'server');
    let works = run.read > 0 || answered;
    const s = ocrSettings();
    for (let tries = 0; doubtful && !works && tries < 2 && !run.stop.signal.aborted && s && ocrIsLocal(s); tries++) {
      if (tries) await sleep(ocrRecheck.ms, undefined, { signal: run.stop.signal }).catch(() => undefined);
      if (run.stop.signal.aborted) break;
      works = await checkOcr(s, run.stop.signal).then(() => true, () => false);
    }
    // A run that was stopped holds nothing against the files: it did not finish with them.
    if (run.stop.signal.aborted) run.stopped ??= 'Stopped.';
    else {
      const by = ocrNow();
      for (const [id, f] of faults) {
        if (f.why === 'unreachable' || f.why === 'setup' || f.after || (f.why && !works)) continue;
        const before = failures.get(id);
        failures.set(id, { modified: f.modified, by, tries: before?.modified === f.modified && before.by === by ? before.tries + 1 : 1 });
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
