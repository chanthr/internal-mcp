/**
 * A lock file in the data directory: one process at a time does a named job.
 *
 * The HTTP server, a second server on the same data directory, a manual command and every stdio session can all
 * want to run the same background work (syncing Drive, scanning a folder). Two at once would do the work twice and,
 * on an empty index, both build it. The first one to create the file works; the others skip. A lock whose process
 * is gone, or that is older than `staleMs`, is taken over.
 *
 * The file holds the process id of its holder, and that alone does not say the holder is still there: after a crash
 * or a power cut the system gives the id to another program (even pid 1), which would hold the lock for as long as
 * it runs, and scans would be skipped for hours. So a holder touches its lock while it works (every BEAT_MS), and a
 * lock is taken over when the process with its id started after the last touch (it cannot be the holder), or when
 * nobody touched it for SILENT_MS (its holder stopped working on it).
 *
 * This covers processes on one machine sharing one data directory. Servers on different machines are not
 * coordinated by it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { processInfo } from './process_info.js';

const DEFAULT_STALE_MS = 12 * 60 * 60_000;
const BEAT_MS = 30_000;
const SILENT_MS = 5 * 60_000;
const lockPath = (name: string) => join(dataDir(), `${name}.lock`);
const beats = new Map<string, NodeJS.Timeout>();

/** Can the process with this id be the one that touched its lock at `touchedMs`? */
function couldHold(pid: number, touchedMs: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: there is such a process, of another user. Its start time still says whether it can be the holder.
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const started = processInfo(pid)?.startedAt;
  // A start time is read to the second: a little slack, so that a holder is never taken for a later process.
  return started == null || started <= touchedMs + 2000;
}

/** Touch the lock while it is held, up to `staleMs`: a holder that takes longer than that is taken over, as before. */
function keepTouching(name: string, staleMs: number): void {
  stopTouching(name);
  const since = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - since >= staleMs) return stopTouching(name);
    try {
      if (readFileSync(lockPath(name), 'utf8').trim() !== String(process.pid)) return stopTouching(name);
      const now = new Date();
      utimesSync(lockPath(name), now, now);
    } catch {
      stopTouching(name); // released, or taken over
    }
  }, BEAT_MS);
  timer.unref?.();
  beats.set(name, timer);
}
function stopTouching(name: string): void {
  const timer = beats.get(name);
  if (timer) clearInterval(timer);
  beats.delete(name);
}

/** Take the lock. False when a live process holds it. */
export function acquireLock(name: string, staleMs = DEFAULT_STALE_MS): boolean {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const path = lockPath(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      // A short lock goes stale within SILENT_MS anyway: only a long one needs touching to show it is still held.
      if (staleMs > SILENT_MS) keepTouching(name, staleMs);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      let touched = 0;
      try {
        pid = Number(readFileSync(path, 'utf8').trim());
        touched = statSync(path).mtimeMs;
      } catch {
        continue; // released between the two calls: try again
      }
      const silent = Date.now() - touched >= Math.min(staleMs, SILENT_MS);
      if (Number.isInteger(pid) && pid > 0 && !silent && couldHold(pid, touched)) return false;
      try {
        unlinkSync(path);
      } catch {
        /* someone else took it over first */
      }
    }
  }
  return false;
}

/** Release the lock if this process holds it. */
export function releaseLock(name: string): void {
  stopTouching(name);
  try {
    if (readFileSync(lockPath(name), 'utf8').trim() === String(process.pid)) unlinkSync(lockPath(name));
  } catch {
    /* already gone */
  }
}

/** Run `fn` while holding the lock. Returns null, without running it, when another process holds the lock. */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  if (!acquireLock(name)) return null;
  try {
    return await fn();
  } finally {
    releaseLock(name);
  }
}
