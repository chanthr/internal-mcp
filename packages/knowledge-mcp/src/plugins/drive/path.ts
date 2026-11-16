/**
 * Drive 파일의 부모 체인 분류 — search_drive 가 민감/제외 폴더를 응답에서 거르는 데 사용.
 *
 * 왜: semantic 색인은 제외 폴더(config drive.excludeFolders, 예: "HR", "Contracts")를 건너뛰지만(exclude.ts),
 * search_drive 는 Drive API 를 직접 때려 service account 가 공유받은 전체를 노출했다 → 계약·PII·HR 유출 위험.
 * 이 모듈로 검색 결과를 "dev/biz root 하위 + 제외 폴더 미경유"로 한정한다.
 *
 * 성능: 폴더 메타(id→name,parent)는 거의 변하지 않으므로 프로세스 캐시 → 부모 walk 가 warmup 후 캐시 hit.
 */
import type { DriveClient, DriveFile } from './client.js';
import { DRIVE_ROOTS, sharedScopeEnabled } from './settings.js';
import { isExcludedName } from './exclude.js';

const ROOT_IDS = new Set(DRIVE_ROOTS.map((r) => r.id));

// 폴더 메타 캐시 (id → {name, parent}). TTL 부여 — 영구 캐시면 폴더를 제외 이름(예: "HR")으로
// rename 하거나 제외 폴더로 move 해도 옛 이름으로 분류돼 새로 민감해진 폴더가 재배포 전까지
// 노출(under-exclude)된다. 짧은 TTL(기본 10분)로 분류 변경을 반영. rename/move 는 드물어 캐시 효과는 유지.
const FOLDER_META_TTL_MS = Number(process.env.FOLDER_META_TTL_MS ?? 600_000);
const _folderMeta = new Map<string, { name: string; parent: string | undefined; expiresAt: number }>();

export async function getFolderMeta(
  drive: DriveClient,
  id: string,
): Promise<{ name: string; parent: string | undefined }> {
  const now = Date.now();
  const cached = _folderMeta.get(id);
  if (cached && cached.expiresAt > now) return { name: cached.name, parent: cached.parent };
  // 조회 실패는 throw 한다(캐시하지 않음). 예전엔 빈 값을 돌려줘 동기화가 "root 밖"으로 보고 멀쩡한 벡터를 지웠다.
  const d = (await drive.files.get({ fileId: id, fields: 'name,parents', supportsAllDrives: true })).data;
  const meta = { name: d.name ?? '', parent: d.parents?.[0], expiresAt: now + FOLDER_META_TTL_MS };
  _folderMeta.set(id, meta);
  return { name: meta.name, parent: meta.parent };
}

/** 폴더 이름이나 위치가 바뀌었을 때(동기화가 폴더 변경을 봤을 때) 캐시를 비운다. */
export function clearFolderMetaCache(): void {
  _folderMeta.clear();
}

/**
 * 'ok'       : under an index root, not through an excluded folder → visible
 * 'shared'   : outside the roots but shared with the service account (directly, or inside a shared folder) → visible
 *              when drive.scope is "shared"
 * 'excluded' : passes through an excluded folder (config drive.excludeFolders, node_modules, …) → hidden
 * 'outside'  : could not be classified (a folder lookup failed, or the chain is too deep), or outside the roots
 *              while drive.scope is "roots" → hidden
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
 * `path` holds folders only (no file name). For 'ok' it starts right under the root ("Clients/Acme"); for 'shared' it
 * starts at the top shared folder ("Team handbook"), and is empty for a file shared on its own. Per-user folder scopes
 * are matched against this path, so a scoped user sees a shared document only if its path is in their allowed list.
 */
export async function classifyAndPath(
  drive: DriveClient,
  parents: string[] | undefined,
): Promise<{ cls: SearchClass; path: string }> {
  const names: string[] = [];
  let chain = parents;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!chain || chain.length === 0) {
      return sharedScopeEnabled() ? { cls: 'shared', path: names.reverse().join('/') } : { cls: 'outside', path: '' };
    }
    if (hop === MAX_HOPS) break;
    const pid = chain[0];
    if (ROOT_IDS.has(pid)) return { cls: 'ok', path: names.reverse().join('/') };
    let meta: { name: string; parent: string | undefined };
    try {
      meta = await getFolderMeta(drive, pid);
    } catch {
      return { cls: 'outside', path: '' };
    }
    if (isExcludedName(meta.name)) return { cls: 'excluded', path: '' };
    if (meta.name) names.push(meta.name);
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
    d = (await drive.files.get({ fileId: folderId, fields: 'name,parents', supportsAllDrives: true })).data;
  } catch {
    return { cls: 'outside', path: '' };
  }
  if (isExcludedName(d.name)) return { cls: 'excluded', path: '' };
  const parent = await classifyAndPath(drive, d.parents ?? undefined);
  if (!isReadableClass(parent.cls)) return { cls: parent.cls, path: '' };
  return { cls: parent.cls, path: parent.path ? `${parent.path}/${d.name ?? ''}` : d.name ?? '' };
}
