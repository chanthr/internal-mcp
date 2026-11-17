/**
 * Drive → Qdrant incremental sync (polling).
 *
 * Uses the Drive Changes API to apply only the files changed, added or deleted since the last sync.
 * - changed/added: re-chunk + embed + upsert (idempotent, same chunk_id)
 * - deleted/trashed: delete every chunk of that file from Qdrant
 * - the pageToken is persisted (sync_state) and is the starting point of the next sync
 *
 * Runs once at startup (the first run only initializes the token), then on a timer (default 30 minutes).
 * Graceful: errors are only logged and do not affect the server.
 */
import type { DriveChangeList, DriveClient } from './client.js';
import { DriveApiError, getDriveClient } from './client.js';
import { indexFile, deleteFileVectors, SUPPORTED_MIMES, DRIVE_ROOTS } from './indexer.js';
import { isTrustedShare, sharedScopeEnabled, SHARED_SOURCE } from './settings.js';
import { getSyncToken, setSyncToken, getRetryList, setRetryList, MAX_RETRY_ATTEMPTS, wasAutoIndexed, markAutoIndexed } from './sync_state.js';
import { isExcludedPath } from './exclude.js';
import { clearFolderMetaCache, getFolderMeta, ownerEmails, type ShareOrigin } from './path.js';
import { DRIVE_COLLECTION, getQdrantClient, type PointId } from './qdrant.js';
import { embedQuery } from './embeddings.js';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../core/paths.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Follows parents up to a root to rebuild path + source. Returns null when outside the roots.
 * Folder hops use getFolderMeta (process cache, 10 minute TTL). Changed files share ancestor folders, so the cache
 * hits after warmup.
 * A failed folder lookup throws. The caller marks only that file as errored and does not delete its vectors.
 */
async function resolveFromParents(
  drive: DriveClient,
  firstParents: string[] | null | undefined,
  fileName: string,
  self: ShareOrigin,
): Promise<{ path: string; source: string } | null> {
  const folders: string[] = [];
  let top: ShareOrigin = self;
  let parents: string[] | undefined = firstParents ?? undefined;
  for (let hop = 0; hop < 12 && parents && parents.length > 0; hop++) {
    const pid = parents[0];
    const root = DRIVE_ROOTS.find((r) => r.id === pid);
    if (root) return { path: [...folders, fileName].join('/'), source: root.source };
    const meta = await getFolderMeta(drive, pid);
    if (meta.name) folders.unshift(meta.name);
    top = meta;
    parents = meta.parent ? [meta.parent] : undefined;
  }
  // Nothing further up: this is the top of what was shared with the service account. With drive.scope "shared"
  // such a file is indexed with its path starting at the top shared folder, provided the top of the share belongs to a
  // trusted owner (drive.trustedOwners). A chain deeper than 12 hops stays out.
  if ((!parents || parents.length === 0) && sharedScopeEnabled() && isTrustedShare(top.owners, top.driveId)) {
    return { path: [...folders, fileName].join('/'), source: SHARED_SOURCE };
  }
  return null;
}

async function resolvePathAndSource(drive: DriveClient, fileId: string, fileName: string) {
  const d = (await drive.files.get({ fileId, fields: 'parents,owners(emailAddress),driveId', supportsAllDrives: true })).data;
  return resolveFromParents(drive, d.parents, fileName, { owners: ownerEmails(d), driveId: d.driveId });
}

/**
 * When a folder is moved or renamed, the Drive change list contains only that one folder. The files inside do not
 * arrive as changes, so the payload file_path keeps the old path, and the folder permission and excluded-folder checks
 * of semantic search run on the old path. So when a folder change is seen, the current path of every indexed file is
 * computed again:
 *   deleted, trashed, outside the roots or in an excluded folder → delete vectors. Path or name changed → reindex.
 *   Unchanged → left as is.
 * A failed lookup for one file is counted as errored and skipped (nothing is deleted).
 */
export async function refreshIndexedPaths(drive: DriveClient): Promise<{ checked: number; reindexed: number; deleted: number; errored: number }> {
  const client = await getQdrantClient();
  const indexed = new Map<string, { path: string; name: string; source: string }>();
  let offset: PointId | undefined;
  do {
    const page = await client.scroll(DRIVE_COLLECTION, {
      limit: 1000,
      offset,
      with_payload: ['file_id', 'file_path', 'file_name', 'source'],
      with_vector: false,
    });
    for (const pt of page.points) {
      const p = (pt.payload ?? {}) as Record<string, unknown>;
      const id = typeof p.file_id === 'string' ? p.file_id : '';
      if (id && !indexed.has(id)) indexed.set(id, { path: String(p.file_path ?? ''), name: String(p.file_name ?? ''), source: String(p.source ?? '') });
    }
    offset = page.next_page_offset ?? undefined;
  } while (offset !== undefined);

  const r = { checked: indexed.size, reindexed: 0, deleted: 0, errored: 0 };
  for (const [id, prev] of indexed) {
    try {
      let f;
      try {
        f = (
          await drive.files.get({ fileId: id, fields: 'id,name,mimeType,modifiedTime,size,trashed,parents,owners(emailAddress),driveId', supportsAllDrives: true })
        ).data;
      } catch (e) {
        if (e instanceof DriveApiError && e.code === 404) {
          await deleteFileVectors(id);
          r.deleted++;
          continue;
        }
        throw e;
      }
      const resolved = f.trashed || !f.name ? null : await resolveFromParents(drive, f.parents, f.name, { owners: ownerEmails(f), driveId: f.driveId });
      if (!resolved || isExcludedPath(resolved.path)) {
        await deleteFileVectors(id);
        r.deleted++;
        continue;
      }
      if (resolved.path !== prev.path || resolved.source !== prev.source || f.name !== prev.name) {
        await indexFile(drive, {
          id,
          name: f.name!,
          path: resolved.path,
          modifiedTime: f.modifiedTime ?? '',
          source: resolved.source,
          mimeType: f.mimeType ?? '',
          size: f.size ? Number(f.size) : undefined,
        });
        r.reindexed++;
      }
    } catch (e) {
      r.errored++;
      console.error(`[drive-sync] path refresh failed (kept as is): fileId=${id} — ${e instanceof Error ? e.message : e}`);
    }
  }
  return r;
}

/**
 * Brings one file to its current state (for the retry list): missing, trashed, outside the roots or in an excluded
 * folder → delete vectors, anything else → index.
 */
async function syncOneFile(drive: DriveClient, fileId: string): Promise<'indexed' | 'deleted' | 'skipped'> {
  let f;
  try {
    f = (await drive.files.get({ fileId, fields: 'id,name,mimeType,modifiedTime,size,trashed,parents,owners(emailAddress),driveId', supportsAllDrives: true })).data;
  } catch (e) {
    if (e instanceof DriveApiError && e.code === 404) {
      await deleteFileVectors(fileId);
      return 'deleted';
    }
    throw e;
  }
  if (!f.name || !f.mimeType || !SUPPORTED_MIMES.has(f.mimeType)) return 'skipped';
  const resolved = f.trashed ? null : await resolveFromParents(drive, f.parents, f.name, { owners: ownerEmails(f), driveId: f.driveId });
  if (!resolved || isExcludedPath(resolved.path)) {
    await deleteFileVectors(fileId);
    return 'deleted';
  }
  await indexFile(drive, {
    id: fileId,
    name: f.name,
    path: resolved.path,
    modifiedTime: f.modifiedTime ?? '',
    source: resolved.source,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
  });
  return 'indexed';
}

export interface SyncResult {
  status: string;
  changed: number;
  deleted: number;
  skipped: number;
  errored?: number;
  /** Set when a folder changed and indexed paths were recomputed. */
  pathRefresh?: { checked: number; reindexed: number; deleted: number; errored: number };
}

/** True when the collection holds nothing and the automatic first index has not run for it yet. */
async function firstIndexNeeded(): Promise<boolean> {
  if (process.env.DRIVE_AUTO_INDEX === 'false') return false;
  if (DRIVE_ROOTS.length === 0 && !sharedScopeEnabled()) return false; // nothing is in scope, so nothing to build
  if (await wasAutoIndexed(DRIVE_COLLECTION)) return false;
  const page = await (await getQdrantClient()).scroll(DRIVE_COLLECTION, { limit: 1, with_payload: false, with_vector: false });
  if (page.points.length > 0) {
    await markAutoIndexed(DRIVE_COLLECTION); // indexed by hand before this feature existed, or by another process
    return false;
  }
  return true;
}

export async function runIncrementalSync(): Promise<SyncResult> {
  const drive = await getDriveClient();
  const token = await getSyncToken();

  // First run: store the startPageToken, so changes are tracked from now on.
  if (!token) {
    const { data } = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    if (data.startPageToken) await setSyncToken(data.startPageToken);
  }
  // An empty collection that was never indexed is indexed now, so nobody has to run `drive reindex` by hand after
  // setup. The token above is stored first: documents edited while the index is being built are picked up by the
  // next cycle. DRIVE_AUTO_INDEX=false leaves the first index to the command.
  if (await firstIndexNeeded()) {
    // Check the embedding endpoint with one call before touching Drive. With a wrong key every file would be
    // downloaded and extracted only to fail at the last step, on every cycle.
    try {
      await embedQuery('ping');
    } catch (e) {
      console.error(`[drive-sync] the index is empty but the embedding endpoint does not answer, so it is not built yet: ${e instanceof Error ? e.message : e}`);
      console.error('[drive-sync] fix the key (knowledge-mcp setup check shows what is wrong); the next cycle tries again');
      return { status: 'waiting for embeddings', changed: 0, deleted: 0, skipped: 0 };
    }
    console.error('[drive-sync] the index is empty: building it now (this can take a while; search fills in as files are indexed)');
    const { runReindex } = await import('./reindex.js');
    // An automatic run never sends files to paid OCR. Scanned files are counted in the log and are indexed by a
    // deliberate `knowledge-mcp drive reindex`.
    await runReindex(['--no-ocr']);
    await markAutoIndexed(DRIVE_COLLECTION);
    return { status: 'first index built', changed: 0, deleted: 0, skipped: 0 };
  }
  if (!token) return { status: 'initialized', changed: 0, deleted: 0, skipped: 0 };

  let changed = 0;
  let deleted = 0;
  let skipped = 0;
  let errored = 0;
  let foldersChanged = false;
  const failedNow = new Set<string>();
  const retry = await getRetryList();
  let cursor: string | undefined = token;

  while (cursor) {
    const data: DriveChangeList = (
      await drive.changes.list({
        pageToken: cursor,
        fields:
          'nextPageToken, newStartPageToken, changes(removed, fileId, file(id,name,mimeType,modifiedTime,trashed,size))',
        pageSize: 100,
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      })
    ).data;

    for (const ch of data.changes ?? []) {
      // If one failing file (Mathpix timeout, OpenAI 5xx retries exhausted, a broken docx, etc.) throws, the loop exits
      // and runIncrementalSync throws as a whole. setSyncToken is then not called for that tick, the pageToken cannot
      // advance, and the next tick stops at the same broken file again (sync stuck forever). Per-file isolation marks
      // only the failing file as errored, and the rest of the files and the token keep moving.
      try {
        const f = ch.file;
        // A folder move, rename, trash or permanent delete (the type is unknown) changes the paths of the files
        // inside, but those files do not arrive as changes.
        if (f?.mimeType === FOLDER_MIME || (ch.removed && !f)) foldersChanged = true;
        if (f?.mimeType === FOLDER_MIME) {
          skipped++;
          continue;
        }
        if (ch.removed || f?.trashed) {
          if (ch.fileId) {
            await deleteFileVectors(ch.fileId);
            deleted++;
          }
          continue;
        }
        if (!f?.id || !f.name || !f.mimeType || !SUPPORTED_MIMES.has(f.mimeType)) {
          skipped++;
          continue;
        }
        const resolved = await resolvePathAndSource(drive, f.id, f.name);
        // Excluded: folders outside dev/biz, sensitive ones (PII/contracts/HR/deprecated) and development artifacts
        // (node_modules etc.), see exclude.ts. For a file moved out of the indexed area or into an excluded folder,
        // the vectors left behind are deleted (only skipping it would keep the old chunk text showing up in
        // semantic_search_drive).
        if (!resolved || isExcludedPath(resolved.path)) {
          await deleteFileVectors(f.id);
          skipped++;
          continue;
        }
        await indexFile(drive, {
          id: f.id,
          name: f.name,
          path: resolved.path,
          modifiedTime: f.modifiedTime ?? '',
          source: resolved.source,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
        });
        changed++;
      } catch (e) {
        errored++;
        if (ch.fileId) failedNow.add(ch.fileId);
        console.error(
          `[drive-sync] file indexing failed (will retry next cycle; page token still advances): fileId=${ch.fileId ?? '?'} — ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (data.newStartPageToken) {
      await setSyncToken(data.newStartPageToken);
      break;
    }
    cursor = data.nextPageToken ?? undefined;
  }

  // Retry the files that failed in the previous cycle. A file already handled as a change in this cycle keeps that
  // result.
  for (const id of Object.keys(retry)) {
    if (failedNow.has(id)) continue;
    try {
      await syncOneFile(drive, id);
      delete retry[id];
    } catch (e) {
      retry[id] = (retry[id] ?? 0) + 1;
      if (retry[id]! >= MAX_RETRY_ATTEMPTS) {
        console.error(`[drive-sync] giving up on fileId=${id} after ${MAX_RETRY_ATTEMPTS} tries — the next full reindex picks it up`);
        delete retry[id];
      } else {
        console.error(`[drive-sync] retry ${retry[id]} failed: fileId=${id} — ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  for (const id of failedNow) retry[id] = (retry[id] ?? 0) + 1;
  await setRetryList(retry);

  if (foldersChanged) {
    clearFolderMetaCache();
    const pathRefresh = await refreshIndexedPaths(drive);
    console.error(
      `[drive-sync] folder change → paths rechecked: ${pathRefresh.checked} files, reindexed ${pathRefresh.reindexed}, deleted ${pathRefresh.deleted}, errored ${pathRefresh.errored}`,
    );
    return { status: 'synced', changed, deleted, skipped, errored, pathRefresh };
  }
  return { status: 'synced', changed, deleted, skipped, errored };
}

// ── One sync at a time across processes ──
// The HTTP server, a second server on the same data directory, and every stdio session can all want to sync. Two at
// once would embed the same files twice and, on an empty index, both build it. A lock file in the data directory
// lets one of them work; the others skip the cycle. A lock whose process is gone, or that is older than 12 hours, is
// taken over.
const LOCK_STALE_MS = 12 * 60 * 60_000;
const lockPath = () => join(dataDir(), 'drive-sync.lock');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireSyncLock(): boolean {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath(), 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      let age = Infinity;
      try {
        pid = Number(readFileSync(lockPath(), 'utf8').trim());
        age = Date.now() - statSync(lockPath()).mtimeMs;
      } catch {
        continue; // released between the two calls: try again
      }
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid) && age < LOCK_STALE_MS) return false;
      try {
        unlinkSync(lockPath());
      } catch {
        /* someone else took it over first */
      }
    }
  }
  return false;
}

export function releaseSyncLock(): void {
  try {
    if (readFileSync(lockPath(), 'utf8').trim() === String(process.pid)) unlinkSync(lockPath());
  } catch {
    /* already gone */
  }
}

/** One sync pass, unless another process is already syncing (then null). */
export async function runSyncOnce(): Promise<SyncResult | null> {
  if (!acquireSyncLock()) return null;
  try {
    return await runIncrementalSync();
  } finally {
    releaseSyncLock();
  }
}

let _started = false;
let _running = false;

/**
 * Called at startup: one run (the first run initializes the token) plus periodic polling.
 *
 * Uses a self-rescheduling setTimeout instead of setInterval. The next tick is scheduled only after the previous sync
 * finishes, so syncs never overlap even when one cycle takes longer than the interval (prevents duplicate embedding
 * and a token rewind). The `_running` reentry guard is a second safety net.
 */
export function startDriveSyncScheduler(intervalMin = 30): void {
  if (_started) return;
  _started = true;

  const run = async () => {
    if (_running) {
      console.error('[drive-sync] previous cycle still running — skipping this tick');
      return;
    }
    _running = true;
    try {
      const r = await runSyncOnce();
      if (!r) {
        console.error('[drive-sync] another process is syncing this data directory — skipping this tick');
        return;
      }
      console.error(
        `[drive-sync] ${r.status} · changed=${r.changed} deleted=${r.deleted} skipped=${r.skipped} errored=${r.errored ?? 0}`,
      );
    } catch (e) {
      console.error('[drive-sync] error:', e instanceof Error ? e.message : e);
    } finally {
      _running = false;
    }
  };

  const scheduleNext = () => {
    setTimeout(() => void run().finally(scheduleNext), intervalMin * 60_000);
  };

  void run().finally(scheduleNext); // one run at startup, then the periodic schedule
  console.error(`[drive-sync] scheduler started — every ${intervalMin} min (self-rescheduling setTimeout + reentry guard)`);
}
