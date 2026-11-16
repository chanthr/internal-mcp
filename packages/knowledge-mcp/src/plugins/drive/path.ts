/**
 * Classifies the parent chain of a Drive file. search_drive uses it to filter sensitive and excluded folders out of
 * its responses.
 *
 * Why: the semantic index skips excluded folders (config drive.excludeFolders, e.g. "HR", "Contracts") (exclude.ts),
 * but search_drive called the Drive API directly and exposed everything shared with the service account, a risk of
 * leaking contracts, PII and HR data. This module limits search results to "under a dev/biz root and not through an
 * excluded folder".
 *
 * Performance: folder metadata (id → name, parent) rarely changes, so it is cached per process and the parent walk
 * hits the cache after warmup.
 */
import type { DriveClient, DriveFile } from './client.js';
import { DRIVE_ROOTS, isTrustedShare, sharedScopeEnabled } from './settings.js';
import { isExcludedName } from './exclude.js';

const ROOT_IDS = new Set(DRIVE_ROOTS.map((r) => r.id));

// Folder metadata cache (id → {name, parent}) with a TTL. With a permanent cache, a folder renamed to an excluded name
// (e.g. "HR") or moved into an excluded folder would still be classified by its old name, and the newly sensitive
// folder would stay exposed (under-exclude) until a redeploy. A short TTL (default 10 minutes) picks up such changes.
// Renames and moves are rare, so the cache stays effective.
const FOLDER_META_TTL_MS = Number(process.env.FOLDER_META_TTL_MS ?? 600_000);
const _folderMeta = new Map<string, FolderMeta & { expiresAt: number }>();

/** Who a shared item belongs to: its owners' emails, or the shared drive it lives in. */
export interface ShareOrigin {
  owners?: string[];
  driveId?: string | null;
}
interface FolderMeta extends ShareOrigin {
  name: string;
  parent: string | undefined;
}

/** Owner emails of a Drive file, as the list the trust check takes. */
export function ownerEmails(f: DriveFile): string[] {
  return (f.owners ?? []).map((o) => o.emailAddress ?? '').filter(Boolean);
}

export async function getFolderMeta(drive: DriveClient, id: string): Promise<FolderMeta> {
  const now = Date.now();
  const cached = _folderMeta.get(id);
  if (cached && cached.expiresAt > now) return cached;
  // A failed lookup throws and is not cached. It used to return an empty value, which made the sync treat the file as
  // "outside the roots" and delete good vectors.
  const d = (await drive.files.get({ fileId: id, fields: 'name,parents,owners(emailAddress),driveId', supportsAllDrives: true })).data;
  const meta = { name: d.name ?? '', parent: d.parents?.[0], owners: ownerEmails(d), driveId: d.driveId ?? null, expiresAt: now + FOLDER_META_TTL_MS };
  _folderMeta.set(id, meta);
  return meta;
}

/** Clears the cache when a folder name or location changes (when the sync sees a folder change). */
export function clearFolderMetaCache(): void {
  _folderMeta.clear();
}

/**
 * 'ok'       : under an index root, not through an excluded folder → visible
 * 'shared'   : outside the roots but shared with the service account (directly, or inside a shared folder) by an
 *              owner in drive.trustedOwners → visible when drive.scope is "shared"
 * 'excluded' : passes through an excluded folder (config drive.excludeFolders, node_modules, …) → hidden
 * 'outside'  : could not be classified (a folder lookup failed, or the chain is too deep), outside the roots while
 *              drive.scope is "roots", or shared by an owner that is not trusted → hidden
 */
export type SearchClass = 'ok' | 'shared' | 'excluded' | 'outside';

/** May this class be returned by search, read and list? */
export function isReadableClass(cls: SearchClass): boolean {
  return cls === 'ok' || cls === 'shared';
}

const MAX_HOPS = 12;

/**
 * Walk up from a file's parents, classify it and return its folder path. Only parents[0] is followed (at most 12 hops).
 *
 * Drive leaves out parents the account cannot see, so when there is nothing further up, that is the top of what was
 * shared with the service account. Reaching that point without meeting a root means 'shared'.
 * A failed folder lookup means 'outside': an excluded folder may sit above it, and a tool does not show what it cannot check.
 *
 * The top of the share decides trust: `self` (owners or shared drive of the item itself) when the item was shared on its
 * own, otherwise the top folder reached. Pass `self` whenever the item's own metadata is at hand.
 *
 * `path` holds folders only (no file name). For 'ok' it starts right under the root ("Clients/Acme"); for 'shared' it
 * starts at the top shared folder ("Team handbook"), and is empty for a file shared on its own. Per-user folder scopes
 * are matched against this path, so a scoped user sees a shared document only if its path is in their allowed list.
 */
export async function classifyAndPath(
  drive: DriveClient,
  parents: string[] | undefined,
  self?: ShareOrigin,
): Promise<{ cls: SearchClass; path: string }> {
  const names: string[] = [];
  let chain = parents;
  let top: ShareOrigin | undefined = self;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!chain || chain.length === 0) {
      return sharedScopeEnabled() && isTrustedShare(top?.owners, top?.driveId)
        ? { cls: 'shared', path: names.reverse().join('/') }
        : { cls: 'outside', path: '' };
    }
    if (hop === MAX_HOPS) break;
    const pid = chain[0];
    if (ROOT_IDS.has(pid)) return { cls: 'ok', path: names.reverse().join('/') };
    let meta: FolderMeta;
    try {
      meta = await getFolderMeta(drive, pid);
    } catch {
      return { cls: 'outside', path: '' };
    }
    if (isExcludedName(meta.name)) return { cls: 'excluded', path: '' };
    if (meta.name) names.push(meta.name);
    top = meta;
    chain = meta.parent ? [meta.parent] : undefined;
  }
  return { cls: 'outside', path: '' };
}

/**
 * Classify a folder itself — the start-folder check of list_drive_folder, and folder hits in search_drive.
 * A root is 'ok' (path ''). Otherwise the folder's own name is checked against the excluded names, then its parent
 * chain is classified. `path` runs down to and including this folder: root/Clients/Acme → "Clients/Acme".
 */
export async function classifyFolder(
  drive: DriveClient,
  folderId: string,
): Promise<{ cls: SearchClass; path: string }> {
  if (ROOT_IDS.has(folderId)) return { cls: 'ok', path: '' };
  let d: DriveFile;
  try {
    d = (await drive.files.get({ fileId: folderId, fields: 'name,parents,owners(emailAddress),driveId', supportsAllDrives: true })).data;
  } catch {
    return { cls: 'outside', path: '' };
  }
  if (isExcludedName(d.name)) return { cls: 'excluded', path: '' };
  const parent = await classifyAndPath(drive, d.parents ?? undefined, { owners: ownerEmails(d), driveId: d.driveId });
  if (!isReadableClass(parent.cls)) return { cls: parent.cls, path: '' };
  return { cls: parent.cls, path: parent.path ? `${parent.path}/${d.name ?? ''}` : d.name ?? '' };
}
