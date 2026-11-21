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
 * known (Windows, or ps failed) does a lock nobody touched for SILENT_MS count as left behind. A lock whose text is
 * not a process id (cut short by a power cut, or still being made) counts as left behind after MAKING_MS.
 *
 * A lock is made whole: its process id is written to a file of its own, which is then given the lock's name (a
 * hard link, refused when the name is taken). Made empty and written after, it could be read in between as a lock
 * without a holder. Where a file system has no hard links (FAT, exFAT, some network shares) it is made directly.
 *
 * Several processes may find the same lock left behind at once. They take turns (`<lock>.takeover`, made the same
 * way): only the one whose turn it is removes the lock, after looking again that it is still the one found left
 * behind, and makes its own. A holder lets go of its lock, and touches it, only while it is still the file it made.
 *
 * Times are judged by the clock of the folder (a file written there now): on a network share whose clock is behind
 * this machine's, a lock made a moment ago would otherwise look minutes old, and its holder younger than its lock.
 *
 * What it does not cover: processes on different machines (servers sharing a network folder); a holder past
 * `staleMs` that lets go in the instant between another process looking at its lock and removing it; and a turn
 * left by a process that died inside it (milliseconds) and then cleared by three processes at the same moment.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
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
/** The locks this process holds: name → the file it made (its inode), so that it never lets go of another's. */
const held = new Map<string, number>();
const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '');
/** What a file system without hard links answers to one. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);
const unique = (path: string) => `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;

/**
 * When a process started (milliseconds since 1970, or null when not known), and a pause at two moments of a
 * takeover: after a lock was found left behind, and after it was removed. Tests replace them.
 */
export const lockHooks: { startedAt: (pid: number) => number | null; pause: (at: 'found' | 'removed') => void } = {
  startedAt: (pid) => processInfo(pid)?.startedAt ?? null,
  pause: () => {},
};

/** Make the file with this process's id, whole, unless one of that name exists. Its inode, or false when it exists. */
function publish(path: string): number | false {
  const draft = unique(path);
  writeFileSync(draft, String(process.pid), { mode: 0o600, flag: 'wx' });
  try {
    const ino = statSync(draft).ino;
    linkSync(draft, path);
    return ino;
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
      return fstatSync(fd).ino;
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (code(e) === 'EEXIST') return false;
    throw e;
  }
}

interface Seen {
  text: string;
  ino: number;
  touched: number;
}
/** The file as it is now, or null when there is none. Read through one handle, so that its text and its times agree. */
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
    return { text: readFileSync(fd, 'utf8'), ino: st.ino, touched: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}
// The text is compared as it is: a lock of NUL bytes or other garbage is the same lock as long as it is unchanged.
const same = (a: Seen, b: Seen): boolean => a.ino === b.ino && a.touched === b.touched && a.text === b.text;
const pidOf = (lock: Seen): number => (/^\s*\d+\s*$/.test(lock.text) ? Number(lock.text) : NaN);

/** The time by the clock of the data folder, which stamps the locks: a file made there now, as a lock is made. */
function folderNow(): number {
  const probe = unique(join(dataDir(), '.clock'));
  try {
    writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    return statSync(probe).mtimeMs;
  } catch {
    return Date.now();
  } finally {
    rmSync(probe, { force: true });
  }
}

/** Was this lock left behind by a holder that is gone (or that has had it for longer than `staleMs`)? */
function leftBehind(lock: Seen, staleMs: number): boolean {
  const now = folderNow();
  const age = now - lock.touched;
  if (age >= staleMs) return true;
  const pid = pidOf(lock);
  // No process id in it: one being made right now (where it cannot be made whole), or a file that was cut short.
  if (!Number.isInteger(pid) || pid <= 0) return age >= MAKING_MS;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: there is such a process, of another user. Its start time still says whether it can be the holder.
    if (code(e) !== 'EPERM') return true;
  }
  const started = lockHooks.startedAt(pid);
  // The start is by this machine's clock and the touch by the folder's: compared on this machine's. A start time
  // is read to the second, so a little slack, so that a holder is never taken for a later process.
  if (started !== null) return started > lock.touched + (Date.now() - now) + 2000;
  return age >= Math.min(staleMs, SILENT_MS);
}

/**
 * This process's turn to take a lock over: the inode of its turn, or false while another process has the turn. A
 * turn held for TURN_MS was left by a process that died in the middle of a takeover. It is moved aside under a name
 * of one's own and removed only if it is still that one, so that two processes clearing it do not both go on.
 */
function takeTurn(turn: string): number | false {
  const mine = publish(turn);
  if (mine !== false) return mine;
  const left = look(turn);
  if (!left) return publish(turn); // finished meanwhile
  if (folderNow() - left.touched < TURN_MS) return false;
  const aside = unique(turn);
  try {
    renameSync(turn, aside);
  } catch (e) {
    if (code(e) === 'ENOENT') return false; // another process cleared it first, and has the turn
    throw e;
  }
  const moved = look(aside);
  if (!moved || !same(moved, left)) {
    // Not the turn left behind: a process that cleared it first has taken its own turn since. It goes back.
    try {
      linkSync(aside, turn);
    } catch {
      /* a third process took a turn meanwhile */
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return publish(turn);
}

/** Remove a file of this process, unless another one has taken its place. */
function removeOwn(path: string, ino: number): void {
  const now = look(path);
  if (now?.ino === ino && pidOf(now) === process.pid) rmSync(path, { force: true });
}

/**
 * Take over the lock found left behind, in turn with other processes. Its inode when this process holds it now,
 * false when another one does, null when it should be looked at again (it changed, or went, since it was found).
 */
function takeOver(path: string, found: Seen): number | false | null {
  const turn = `${path}.takeover`;
  const mine = takeTurn(turn);
  if (mine === false) return false; // another process is taking it over right now
  try {
    const now = look(path);
    if (!now || !same(now, found)) return null;
    try {
      unlinkSync(path);
    } catch (e) {
      if (code(e) === 'ENOENT') return null; // its holder let go of it meanwhile
      throw e;
    }
    lockHooks.pause('removed');
    return publish(path);
  } finally {
    removeOwn(turn, mine);
  }
}

/**
 * Touch the lock while it is held (and is still the file this process made). Once it has been held for `staleMs`,
 * its time is set back to when it was taken: a holder that hangs is taken over then, as before there was touching.
 */
function keepTouching(name: string, staleMs: number): void {
  stopTouching(name);
  const since = Date.now();
  const touch = (at: Date) => {
    const now = look(lockPath(name));
    if (!now || now.ino !== held.get(name) || pidOf(now) !== process.pid) return false;
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
    // An inode (0 on some file systems), or false when the name is taken.
    let got: number | false | null = publish(path);
    if (got === false) {
      const found = look(path);
      if (!found) continue; // released meanwhile: try again
      if (!leftBehind(found, staleMs)) return false;
      lockHooks.pause('found');
      got = takeOver(path, found);
      if (got === null) continue;
      if (got === false) return false;
    }
    held.set(name, got);
    // A short lock goes stale within SILENT_MS anyway: only a long one needs touching to show it is still held.
    if (staleMs > SILENT_MS) keepTouching(name, staleMs);
    return true;
  }
  return false;
}

/** Release the lock if this process holds it: the file it made, not one another process made since. */
export function releaseLock(name: string): void {
  stopTouching(name);
  const ino = held.get(name);
  held.delete(name);
  if (ino === undefined) return;
  try {
    removeOwn(lockPath(name), ino);
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
