/**
 * A lock file in the data directory: one process at a time does a named job.
 *
 * The HTTP server, a second server on the same data directory, a manual command and every stdio session can all
 * want to run the same background work (syncing Drive, scanning a folder). Two at once would do the work twice and,
 * on an empty index, both build it. The first one to create the file works; the others skip. A lock whose process
 * is gone, or that is older than `staleMs`, is taken over.
 *
 * This covers processes on one machine sharing one data directory. Servers on different machines are not
 * coordinated by it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const DEFAULT_STALE_MS = 12 * 60 * 60_000;
const lockPath = (name: string) => join(dataDir(), `${name}.lock`);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      let age = Infinity;
      try {
        pid = Number(readFileSync(path, 'utf8').trim());
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between the two calls: try again
      }
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid) && age < staleMs) return false;
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
