/**
 * A JSON file under the data directory that several processes read and one writes at a time: readable by the
 * owner only, written whole and swapped in, so a reader never sees half of it.
 */
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dataDir } from './paths.js';

const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '');
/**
 * Why a file cannot be swapped in, though it can be written: the folder may not be written (EACCES, EPERM), the
 * file is mounted on its own (a single file mounted into a container: EBUSY), or it is on another device (EXDEV).
 */
const IN_PLACE = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV']);

/** Where a write to `path` lands: through links, also a link to a file that does not exist yet. */
function destination(path: string): { target: string; st: Stats | null } {
  let target = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    let st: Stats;
    try {
      st = lstatSync(target);
    } catch (e) {
      if (code(e) === 'ENOENT') return { target, st: null };
      throw e;
    }
    if (!st.isSymbolicLink()) return { target, st };
    target = resolve(realpathSync(dirname(target)), readlinkSync(target));
  }
  throw Object.assign(new Error(`${path}: too many links`), { code: 'ELOOP' });
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at, at);
}

/** Write over the file where it is: what a plain write did, for files that cannot be swapped. */
function writeInPlace(target: string, bytes: Uint8Array, mode: number | undefined): void {
  const fd = openSync(target, 'r+');
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    writeAll(fd, bytes);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Windows refuses a rename for a moment while another program (a virus scanner, an indexer) has the new file open:
 * asked again a few times, briefly.
 */
function renameOver(from: string, to: string): void {
  for (let tries = 0; ; tries++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (process.platform !== 'win32' || tries >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code(e))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 << tries);
    }
  }
}

/**
 * Write a file whole and swap it in. The text goes to a temporary file beside it, is flushed to the disk, and takes
 * the file's place in one rename: a full disk or a crash in the middle leaves the file as it was, never cut short (a
 * config cut short stops the next start; a .env cut short loses keys). The file keeps its permissions (a config or a
 * .env may be readable by its owner only), or gets `mode` when one is given. A file that may not be written (made
 * read-only) is refused, as a write in place would be: a rename could replace it all the same.
 *
 * Some files cannot be swapped, and are written in place as before, without that protection: one in a folder that
 * may not be written, one mounted on its own (a config mounted into a container), one on another device, one with
 * more than one name (a hard link: a new file would leave the other names on the old text), and one of another
 * owner that the new file cannot be given. A link is written
 * where it points, also when that file does not exist yet, so the link stays.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  const { target, st } = destination(path);
  if (st) accessSync(target, constants.W_OK);
  const mode = opts.mode ?? (st ? st.mode & 0o777 : undefined);
  if (st && st.nlink > 1) return writeInPlace(target, bytes, opts.mode);
  // A name of its own: two processes writing the same file (two containers on one volume can both be pid 1) do not
  // write into each other's temporary file.
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', mode ?? 0o666);
  } catch (e) {
    if (st && IN_PLACE.has(code(e))) return writeInPlace(target, bytes, opts.mode);
    throw e;
  }
  // The new file is the writer's: one written by root for someone else (`sudo … setup`) would leave a .env its owner
  // can no longer read. It is given the file's owner and group, or, where that is not allowed, the file is written
  // in place, as before.
  if (st && process.platform !== 'win32') {
    const made = fstatSync(fd);
    if (made.uid !== st.uid || made.gid !== st.gid) {
      try {
        fchownSync(fd, st.uid, st.gid);
      } catch {
        closeSync(fd);
        rmSync(tmp, { force: true });
        return writeInPlace(target, bytes, opts.mode);
      }
    }
  }
  try {
    try {
      if (mode !== undefined) fchmodSync(fd, mode); // the mode given to open is narrowed by the umask
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    renameOver(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (st && IN_PLACE.has(code(e))) return writeInPlace(target, bytes, opts.mode);
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
