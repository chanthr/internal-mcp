/**
 * A JSON file under the data directory that several processes read and one writes at a time: readable by the
 * owner only, written whole and swapped in, so a reader never sees half of it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './paths.js';

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
      const tmp = `${path()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path());
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
