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
 * A lock is made whole: its process id is written to a file of its own, which is then given the lock's name (a
 * hard link, refused when the name is taken). Made empty and written after, it could be read in between as a lock
 * without a holder. Where a file system has no hard links (FAT, exFAT, some network shares) it is made directly.
 *
 * Several processes may find the same lock left behind at once. They take turns (`<lock>.takeover`, made the same
 * way): only the one whose turn it is removes the lock, after looking again that it is still the one found left
 * behind, and makes its own. Nobody moves or removes a lock it did not find left behind.
 *
 * This covers processes on one machine sharing one data directory. Servers on different machines are not
 * coordinated by it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { processInfo } from './process_info.js';

const DEFAULT_STALE_MS = 12 * 60 * 60_000;
const BEAT_MS = 30_000;
const SILENT_MS = 5 * 60_000;
/** A lock without a readable process id is one being made, for this long: after that it is left behind. */
const MAKING_MS = 10_000;
/** A takeover takes milliseconds: a turn held for this long was left by a process that died in the middle of it. */
const TURN_MS = 10_000;
const lockPath = (name: string) => join(dataDir(), `${name}.lock`);
const beats = new Map<string, NodeJS.Timeout>();
const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '');
/** What a file system without hard links answers to one. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

/**
 * When a process started (milliseconds since 1970, or null when not known), and a pause at two moments of a
 * takeover: after a lock was found left behind, and after it was removed. Tests replace them.
 */
export const lockHooks: { startedAt: (pid: number) => number | null; pause: (at: 'found' | 'removed') => void } = {
  startedAt: (pid) => processInfo(pid)?.startedAt ?? null,
  pause: () => {},
};

/** Make the file with this process's id, whole, unless one of that name exists. False when it exists. */
function publish(path: string): boolean {
  const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(draft, String(process.pid), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(draft, path);
    return true;
  } catch (e) {
    if (code(e) === 'EEXIST') return false;
    if (!NO_LINKS.has(code(e))) throw e;
  } finally {
    rmSync(draft, { force: true });
  }
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if (code(e) === 'EEXIST') return false;
    throw e;
  }
}

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
const same = (a: Seen, b: Seen): boolean => a.ino === b.ino && a.touched === b.touched && a.pid === b.pid;

/** Was this lock left behind by a holder that is gone (or that has had it for longer than `staleMs`)? */
function leftBehind(lock: Seen, staleMs: number): boolean {
  const age = Date.now() - lock.touched;
  if (age >= staleMs) return true;
  // No process id in it: one being made right now (where it cannot be made whole), or a file that was cut short.
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return age >= MAKING_MS;
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

/** This process's turn to take a lock over, or false while another process has it. */
function takeTurn(turn: string): boolean {
  if (publish(turn)) return true;
  try {
    if (Date.now() - statSync(turn).mtimeMs < TURN_MS) return false;
    unlinkSync(turn); // left by a process that died while taking the lock over
  } catch {
    /* finished meanwhile */
  }
  return publish(turn);
}

/**
 * Take over the lock found left behind, in turn with other processes. True when this process holds it now, false when
 * another one does, null when it should be looked at again (it changed since it was found).
 */
function takeOver(path: string, found: Seen): boolean | null {
  const turn = `${path}.takeover`;
  if (!takeTurn(turn)) return false; // another process is taking it over right now
  try {
    const now = look(path);
    if (!now || !same(now, found)) return null;
    unlinkSync(path);
    lockHooks.pause('removed');
    return publish(path);
  } finally {
    rmSync(turn, { force: true });
  }
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
    let got: boolean | null = publish(path);
    if (!got) {
      const found = look(path);
      if (!found) continue; // released meanwhile: try again
      if (!leftBehind(found, staleMs)) return false;
      lockHooks.pause('found');
      got = takeOver(path, found);
      if (got === null) continue;
    }
    // A short lock goes stale within SILENT_MS anyway: only a long one needs touching to show it is still held.
    if (got && staleMs > SILENT_MS) keepTouching(name, staleMs);
    return got;
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
