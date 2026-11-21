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
 * process that started after the last touch is not the holder: its lock is taken over at once. Nothing else is held
 * against a holder that runs and started before: it may not have touched the lock for an hour because the machine
 * slept, or because it is an older version that does not touch it. Only where the start of a process cannot be
 * known (Windows, or ps failed) does a lock nobody touched for SILENT_MS count as left behind.
 *
 * Two processes may find the same lock left behind at once. It is taken over by moving it aside under a name of
 * one's own first: only one of them moves it, and the one who moved something else (a lock just made by the
 * other) puts it back.
 *
 * This covers processes on one machine sharing one data directory. Servers on different machines are not
 * coordinated by it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { processInfo } from './process_info.js';

const DEFAULT_STALE_MS = 12 * 60 * 60_000;
const BEAT_MS = 30_000;
const SILENT_MS = 5 * 60_000;
const lockPath = (name: string) => join(dataDir(), `${name}.lock`);
const beats = new Map<string, NodeJS.Timeout>();
const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '');

/** When a process started (milliseconds since 1970, or null when not known), and a pause before a takeover. Tests replace them. */
export const lockHooks: { startedAt: (pid: number) => number | null; beforeTakeover: () => void } = {
  startedAt: (pid) => processInfo(pid)?.startedAt ?? null,
  beforeTakeover: () => {},
};

interface Seen {
  pid: number;
  ino: number;
  touched: number;
}
/** The lock as it is now, or null when there is none. Read through one handle, so that its text and its times agree. */
function look(path: string): Seen | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    return { pid: Number(readFileSync(fd, 'utf8').trim()), ino: st.ino, touched: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** Was this lock left behind by a holder that is gone (or that has had it for longer than `staleMs`)? */
function leftBehind(lock: Seen, staleMs: number): boolean {
  const age = Date.now() - lock.touched;
  if (!Number.isInteger(lock.pid) || lock.pid <= 0 || age >= staleMs) return true;
  try {
    process.kill(lock.pid, 0);
  } catch (e) {
    // EPERM: there is such a process, of another user. Its start time still says whether it can be the holder.
    if (code(e) !== 'EPERM') return true;
  }
  const started = lockHooks.startedAt(lock.pid);
  // A start time is read to the second: a little slack, so that a holder is never taken for a later process.
  if (started !== null) return started > lock.touched + 2000;
  return age >= Math.min(staleMs, SILENT_MS);
}

/**
 * Touch the lock while it is held. Once it has been held for `staleMs`, its time is set back to when it was taken:
 * a holder that hangs is taken over then, as before there was touching.
 */
function keepTouching(name: string, staleMs: number): void {
  stopTouching(name);
  const since = Date.now();
  const touch = (at: Date) => {
    if (readFileSync(lockPath(name), 'utf8').trim() !== String(process.pid)) return false;
    utimesSync(lockPath(name), at, at);
    return true;
  };
  const timer = setInterval(() => {
    try {
      if (Date.now() - since >= staleMs) {
        touch(new Date(since));
        return stopTouching(name);
      }
      if (!touch(new Date())) stopTouching(name);
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      // A short lock goes stale within SILENT_MS anyway: only a long one needs touching to show it is still held.
      if (staleMs > SILENT_MS) keepTouching(name, staleMs);
      return true;
    } catch (e) {
      if (code(e) !== 'EEXIST') throw e;
    }
    const seen = look(path);
    if (!seen) continue; // released meanwhile: try again
    if (!leftBehind(seen, staleMs)) return false;
    lockHooks.beforeTakeover();
    // Moved aside under a name of its own: of two processes taking it over, only one moves it.
    const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      renameSync(path, aside);
    } catch (e) {
      if (code(e) === 'ENOENT') continue; // another process took it first: look at what it made
      throw e;
    }
    const moved = look(aside);
    if (moved && (moved.ino !== seen.ino || moved.touched !== seen.touched || moved.pid !== seen.pid)) {
      // Not the lock that was found left behind: another process took that over in between, and this is its new
      // lock. It is theirs, and goes back where it was.
      try {
        linkSync(aside, path);
      } catch {
        /* a third process made one meanwhile */
      }
      rmSync(aside, { force: true });
      return false;
    }
    rmSync(aside, { force: true });
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
