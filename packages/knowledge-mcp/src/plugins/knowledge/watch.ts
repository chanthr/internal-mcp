/**
 * Noticing at once that a file in a folder was added, changed or removed, instead of at the next timed pass.
 *
 * The folders are watched (fs.watch, recursive: macOS and Windows natively, Linux from Node 20). A burst of changes
 * (a folder copied in, an editor saving in steps) becomes one pass, a few seconds after it settles. The timed pass
 * stays: a watch can miss changes (a network drive, a folder replaced as a whole), and the timer catches them.
 *
 * Hidden files and the temporary files editors and office programs write (".~lock", "~$", ".swp") are not changes
 * of a document. KNOWLEDGE_WATCH=false turns watching off.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { LocalFolder } from './folders.js';

/** A change worth a pass: not a hidden file or folder, not an editor's or office program's temporary file. */
export function worthAPass(name: string | null): boolean {
  if (!name) return true; // the platform did not say which file: assume it matters
  const parts = name.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.'))) return false;
  const file = parts.at(-1) ?? '';
  return !/^~\$|^~.*\.tmp$|\.(swp|swx|tmp|crdownload|part|download)$|^\.?~lock\./i.test(file);
}

/**
 * Watch the folders; `onChange` runs once `settleMs` after the last change worth a pass. Returns a function that
 * stops watching. A folder that cannot be watched is said once through `log` and left to the timed pass.
 */
export function watchFolders(folders: LocalFolder[], onChange: () => void, log: (...a: unknown[]) => void = () => {}, settleMs = 3_000): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const changed = (name: string | null) => {
    if (!worthAPass(name)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, settleMs);
    timer.unref?.();
  };
  for (const folder of folders) {
    try {
      const w = watch(folder.path, { recursive: true, persistent: false }, (_event, name) => changed(name == null ? null : String(name)));
      w.on('error', (e) => log(`folders: stopped watching ${folder.path} (${e instanceof Error ? e.message : e}); the timed scan still reads it`));
      watchers.push(w);
    } catch (e) {
      log(`folders: cannot watch ${folder.path} (${e instanceof Error ? e.message : e}); the timed scan reads it`);
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
