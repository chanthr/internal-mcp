/**
 * Files dropped on the console.
 *
 * Adding documents used to mean typing the path of a folder. A file dropped on the page is copied into one
 * folder of this server instead (`uploads/` beside mcp.config.json), which is then a folder like any other: it is
 * scanned, searched and linked.
 *
 * What may be written is narrow on purpose. The name comes from a browser, so it is taken apart and put together
 * again: no "..", no hidden or excluded names, only the file types that can be searched, and never through a
 * symbolic link. Nothing outside `uploads/` can be reached.
 */
import { lstatSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { isExcludedName } from '../plugins/drive/exclude.js';
import { mimeForFileName } from '../plugins/drive/extract_text.js';

export const UPLOADS = 'uploads';
/** The folder uploads go to. `dir` holds mcp.config.json. */
export const uploadsDir = (dir: string): string => join(dir, UPLOADS);

export const SEARCHABLE = 'Markdown, text, PDF, Word, PowerPoint and Excel files';

/** The path a browser gave → the parts of a path inside `uploads/`. Throws what is wrong with it. */
export function uploadParts(raw: string): string[] {
  const parts = raw.normalize('NFC').replace(/\\/g, '/').split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('The file has no name.');
  if (parts.length > 20) throw new Error('The file is too many folders deep.');
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.') || /[\0-\x1f\x7f]/.test(p) || p.length > 200 || isExcludedName(p)) {
      throw new Error(`"${p.slice(0, 60)}" cannot be part of a path here (hidden, excluded or not a name).`);
    }
  }
  const name = parts[parts.length - 1];
  if (!mimeForFileName(name)) throw new Error(`${name}: this type of file cannot be searched. ${SEARCHABLE} can.`);
  return parts;
}

/** Save one uploaded file. Returns its path inside `uploads/` and whether it replaced a file that was there. */
export async function saveUpload(dir: string, rawPath: string, bytes: Buffer): Promise<{ path: string; size: number; replaced: boolean }> {
  const parts = uploadParts(rawPath);
  const root = uploadsDir(dir);
  const abs = join(root, ...parts);
  if (!abs.startsWith(root + sep)) throw new Error('That path leaves the uploads folder.');
  // Nothing on the way may be a link: it could lead out of the folder.
  for (let i = 0; i <= parts.length; i++) {
    const at = join(root, ...parts.slice(0, i));
    try {
      if (lstatSync(at).isSymbolicLink()) throw new Error(`"${parts.slice(0, i).join('/') || UPLOADS}" is a link. Files are not written through links.`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; // nothing there yet, and nothing below it either
      throw e;
    }
  }
  const replaced = await stat(abs).then((s) => s.isFile(), () => false);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.uploading`;
  await writeFile(tmp, bytes);
  await rename(tmp, abs);
  return { path: parts.join('/'), size: bytes.length, replaced };
}
