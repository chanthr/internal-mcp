/**
 * Local folders as a knowledge source.
 *
 * Point the server at a folder (config `folders`, env KNOWLEDGE_FOLDERS) and every Markdown, text, PDF, Word,
 * PowerPoint and Excel file under it is indexed and searchable. No account, no key, nothing to share: the fastest
 * way from "I have documents" to "my assistant can search them".
 *
 * A document id is `local:<folder name>/<relative path>`. Reading one resolves the id back to a file and checks that
 * it is still inside the configured folder, so an id cannot be used to read an arbitrary file.
 *
 * A scan stores the text first and makes the vectors afterwards. Reading 500 files takes seconds; embedding them
 * takes minutes (seven, measured with a local model). Done in that order, keyword search covers every file after
 * the first few seconds, and search by meaning fills in behind it, instead of nothing being searchable until the
 * last vector is made.
 *
 * A scan compares each file's modified time with what is indexed: unchanged files are not opened, changed and new
 * files are indexed, and documents whose file is gone are removed. A scan never uses paid OCR: scanned PDFs are
 * counted and left out.
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { getConfig } from '../../core/config.js';
import { appRoot } from '../../core/paths.js';
import { withLock } from '../../core/lock.js';
import { isExcludedName } from '../drive/exclude.js';
import { extractLocalFile, mimeForFileName } from '../drive/extract_text.js';
import { backfillVectors, deleteFileVectors, indexText } from '../drive/indexer.js';
import { DRIVE_COLLECTION, ensureCollection, getLocalIndex, getQdrantClient, vectorProblem } from '../drive/qdrant.js';
import { embeddingsConfigured } from '../drive/embeddings.js';
import { MAX_FILE_BYTES } from '../drive/settings.js';

export const LOCAL_PREFIX = 'local:';
/** A scan stops listing after this many files, so pointing at a huge tree cannot exhaust memory. */
const MAX_FILES_PER_FOLDER = Number(process.env.KNOWLEDGE_MAX_FILES ?? 20_000);

export interface LocalFolder {
  /** Absolute path. */
  path: string;
  /** How the folder shows in results and ids. Unique among the configured folders. */
  name: string;
  /** Label for the `source` search filter. */
  source: string;
}

/** The configured folders: config `folders`, then env KNOWLEDGE_FOLDERS (comma-separated paths). */
export function localFolders(): LocalFolder[] {
  const fromEnv = (process.env.KNOWLEDGE_FOLDERS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((path) => ({ path, name: undefined as string | undefined, source: undefined as string | undefined }));
  const out: LocalFolder[] = [];
  const used = new Set<string>();
  for (const f of [...getConfig().folders, ...fromEnv]) {
    const path = isAbsolute(f.path) ? resolve(f.path) : resolve(appRoot(), f.path);
    if (out.some((o) => o.path === path)) continue;
    // Two folders with the same last segment would share ids. Number the later ones.
    const base = (f.name ?? basename(path)) || 'folder';
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    out.push({ path, name, source: f.source ?? 'files' });
  }
  return out;
}

export function foldersConfigured(): boolean {
  return localFolders().length > 0;
}

export const isLocalId = (id: string): boolean => id.startsWith(LOCAL_PREFIX);

export interface LocalFile {
  id: string;
  /** Path as shown and as matched by per-user folder scopes: "<folder name>/<relative path>". */
  path: string;
  name: string;
  abs: string;
  mimeType: string;
  size: number;
  modifiedTime: string;
}

/** A name that is never indexed: dot files and folders, and the excluded folder names (node_modules, config excludeFolders, …). */
function skipName(name: string): boolean {
  return name.startsWith('.') || isExcludedName(name);
}

/** Supported files under a folder. Symbolic links are not followed: they could point outside the folder, or loop. */
export async function listLocalFiles(folder: LocalFolder): Promise<{ files: LocalFile[]; truncated: boolean }> {
  const files: LocalFile[] = [];
  let truncated = false;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      if (skipName(e.name) || e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, relPath);
      } else if (e.isFile()) {
        const mimeType = mimeForFileName(e.name);
        if (!mimeType) continue;
        const st = await stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        if (files.length >= MAX_FILES_PER_FOLDER) {
          truncated = true;
          return;
        }
        files.push({
          id: `${LOCAL_PREFIX}${folder.name}/${relPath}`,
          path: `${folder.name}/${relPath}`,
          name: e.name,
          abs,
          mimeType,
          size: st.size,
          modifiedTime: st.mtime.toISOString(),
        });
      }
    }
  };
  await walk(folder.path, '');
  return { files, truncated };
}

/**
 * Turn a document id back into a file, or null when the id does not name a file inside a configured folder.
 * Checks the path three ways: no ".." or skipped segment in the id, the folder must be configured, and the real
 * path (after resolving links) must still be inside the folder's real path.
 */
export async function resolveLocalId(id: string): Promise<(LocalFile & { folder: LocalFolder }) | null> {
  if (!isLocalId(id)) return null;
  const rest = id.slice(LOCAL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const folder = localFolders().find((f) => f.name === rest.slice(0, slash));
  const rel = rest.slice(slash + 1);
  const segments = rel.split('/');
  if (!folder || !rel || segments.some((s) => s === '' || s === '.' || s === '..' || skipName(s))) return null;
  const mimeType = mimeForFileName(segments[segments.length - 1]);
  if (!mimeType) return null;
  const abs = join(folder.path, ...segments);
  try {
    const [realFile, realFolder, info] = await Promise.all([realpath(abs), realpath(folder.path), lstat(abs)]);
    if (!info.isFile() || !realFile.startsWith(realFolder + sep)) return null;
    return {
      folder,
      id,
      path: `${folder.name}/${rel}`,
      name: segments[segments.length - 1],
      abs,
      mimeType,
      size: info.size,
      modifiedTime: info.mtime.toISOString(),
    };
  } catch {
    return null; // does not exist, or not readable
  }
}

/** Indexed local documents: id → the modified time recorded when each was indexed. */
async function indexedLocalDocs(): Promise<Map<string, string>> {
  // The built-in index answers from its document index. (Paging through every chunk to learn the same thing read
  // the text of the whole index on every pass.)
  const local = await getLocalIndex();
  if (local) return local.documentTimes(DRIVE_COLLECTION, LOCAL_PREFIX);
  const client = await getQdrantClient();
  const out = new Map<string, string>();
  let offset: string | number | null | undefined;
  do {
    const page = await client.scroll(DRIVE_COLLECTION, {
      limit: 2000,
      offset: offset ?? undefined,
      with_payload: ['file_id', 'modified_time'],
      with_vector: false,
    });
    for (const pt of page.points) {
      const id = String(pt.payload?.file_id ?? '');
      if (isLocalId(id) && !out.has(id)) out.set(id, String(pt.payload?.modified_time ?? ''));
    }
    offset = page.next_page_offset ?? null;
  } while (offset !== null);
  return out;
}

export interface FolderScanResult {
  folders: number;
  files: number;
  indexed: number;
  unchanged: number;
  /** Files with no extractable text: empty, or scans that would need OCR. */
  skipped: number;
  removed: number;
  errored: number;
  /** Folders that could not be read this time. Their documents are kept. */
  unreadable: string[];
}

// Files that had no text at this modified time. Remembered for the life of the process so a timer does not parse
// the same scanned PDF on every pass.
const noText = new Map<string, string>();

/**
 * One pass over every configured folder. Returns null when another process is already scanning.
 * Documents of a folder that cannot be read right now (an unmounted disk) are kept; documents of a folder that was
 * removed from the config are deleted.
 */
export async function scanFolders(log: (...a: unknown[]) => void = () => {}): Promise<FolderScanResult | null> {
  const result = await withLock('folders-scan', async () => {
    await ensureCollection();
    const folders = localFolders();
    const indexed = await indexedLocalDocs();
    const r: FolderScanResult = { folders: folders.length, files: 0, indexed: 0, unchanged: 0, skipped: 0, removed: 0, errored: 0, unreadable: [] };
    const seen = new Set<string>();
    const keepPrefixes: string[] = [];

    for (const folder of folders) {
      let listing: Awaited<ReturnType<typeof listLocalFiles>>;
      try {
        listing = await listLocalFiles(folder);
      } catch (e) {
        r.unreadable.push(folder.path);
        keepPrefixes.push(`${LOCAL_PREFIX}${folder.name}/`);
        log(`folder ${folder.path} cannot be read (${e instanceof Error ? e.message : e}); its documents are kept`);
        continue;
      }
      if (listing.truncated) {
        // Not every file was listed, so "not seen" does not mean "gone".
        keepPrefixes.push(`${LOCAL_PREFIX}${folder.name}/`);
        log(`folder ${folder.path} has more than ${MAX_FILES_PER_FOLDER} files; only the first ${MAX_FILES_PER_FOLDER} are indexed (KNOWLEDGE_MAX_FILES)`);
      }
      for (const file of listing.files) {
        r.files++;
        seen.add(file.id);
        if (indexed.get(file.id) === file.modifiedTime) {
          r.unchanged++;
          continue;
        }
        if (noText.get(file.id) === file.modifiedTime) {
          r.skipped++;
          continue;
        }
        try {
          const { text, needsOcr } = await extractLocalFile(file.abs, file.mimeType);
          if (needsOcr || text.trim().length === 0) {
            noText.set(file.id, file.modifiedTime);
            if (indexed.has(file.id)) await deleteFileVectors(file.id); // it had text before and has none now
            r.skipped++;
            continue;
          }
          await indexText({ id: file.id, name: file.name, path: file.path, modifiedTime: file.modifiedTime, source: folder.source, mimeType: file.mimeType, size: file.size }, text, undefined, { vectors: false });
          r.indexed++;
        } catch (e) {
          r.errored++;
          log(`could not index ${file.path}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    for (const id of indexed.keys()) {
      if (seen.has(id) || keepPrefixes.some((p) => id.startsWith(p))) continue;
      await deleteFileVectors(id);
      r.removed++;
    }
    return r;
  });
  if (!result) return null;
  // Vectors come after the pass, with the scan lock let go: making them for a large index takes long, and the next
  // pass (a file that was just saved) must not wait for it.
  try {
    const problem = embeddingsConfigured() ? await vectorProblem() : null;
    if (problem) log(`search by meaning is off: ${problem}`);
    const filled = await backfillVectors();
    if (filled > 0) log(`added vectors to ${filled} chunk(s) indexed before an embedding model was set`);
  } catch (e) {
    log(`adding vectors failed (keyword search is unaffected): ${e instanceof Error ? e.message : e}`);
  }
  return result;
}

let _timer: NodeJS.Timeout | null = null;

/** Scan now, then again on a timer (HTTP server). Each pass is scheduled after the previous one ends. */
export function startFolderScans(intervalMin: number, log: (...a: unknown[]) => void): void {
  if (_timer) return;
  const run = async () => {
    try {
      const r = await scanFolders(log);
      if (!r) log('folders: another process is scanning — skipped');
      else if (r.indexed || r.removed || r.errored || r.unreadable.length) {
        log(`folders: ${r.files} files · indexed ${r.indexed} · removed ${r.removed} · no text ${r.skipped} · errors ${r.errored}`);
      }
    } catch (e) {
      log('folders: scan failed:', e instanceof Error ? e.message : e);
    }
  };
  const next = () => {
    _timer = setTimeout(() => void run().finally(next), intervalMin * 60_000);
    _timer.unref?.();
  };
  void run().finally(next);
}
