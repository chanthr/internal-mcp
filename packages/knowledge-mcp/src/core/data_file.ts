/**
 * A JSON file under the data directory that several processes read and one writes at a time: readable by the
 * owner only, written whole and swapped in, so a reader never sees half of it.
 */
import { accessSync, closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * Write a file whole and swap it in. The text goes to a temporary file beside it, is flushed to the disk, and takes
 * the file's place in one rename: a full disk or a crash in the middle leaves the file as it was, never cut short (a
 * config cut short stops the next start; a .env cut short loses keys). The file keeps its permissions (a config or a
 * .env may be readable by its owner only), or gets `mode` when one is given. A file that is a link to another is
 * written where it points, so the link stays. A file that may not be written (made read-only) is refused, as a
 * write in place would be: a rename could replace it all the same.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  let target = path;
  let mode = opts.mode;
  let exists = true;
  try {
    target = realpathSync(path);
    mode ??= statSync(target).mode & 0o777;
  } catch {
    exists = false; // a new file
  }
  if (exists) accessSync(target, constants.W_OK);
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode ?? 0o666);
  try {
    try {
      if (mode !== undefined) fchmodSync(fd, mode); // the mode given to open is narrowed by the umask
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // The rename itself is on the disk once the folder is flushed. Not every system can flush a folder (Windows).
  try {
    const dir = openSync(dirname(target), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    /* the file is written; only the moment it is on the disk is left to the system */
  }
}

export interface DataFile<T> {
  path(): string;
  read(): T | null;
  write(value: T): void;
  forget(): void;
  /** Changes whenever the file does (or "" when there is none): what a cache of its contents is keyed by. */
  stamp(): string;
}

export function dataFile<T extends object>(relative: string): DataFile<T> {
  const path = () => join(dataDir(), relative);
  return {
    path,
    read() {
      try {
        const j = JSON.parse(readFileSync(path(), 'utf8'));
        return j && typeof j === 'object' ? (j as T) : null;
      } catch {
        return null;
      }
    },
    write(value) {
      mkdirSync(dirname(path()), { recursive: true, mode: 0o700 });
      writeFileAtomic(path(), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    },
    forget() {
      rmSync(path(), { force: true });
    },
    stamp() {
      try {
        const st = statSync(path());
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '';
      }
    },
  };
}
