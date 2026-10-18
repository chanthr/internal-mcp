/**
 * Drive 파일의 부모 체인 분류 — search_drive 가 민감/제외 폴더를 응답에서 거르는 데 사용.
 *
 * 왜: semantic 색인은 `06_증빙_PII`·`02_계약_법무`·`07_채용_HR`·deprecated 를 제외(exclude.ts)하지만,
 * search_drive 는 Drive API 를 직접 때려 service account 가 공유받은 전체를 노출했다 → 계약·PII·HR 유출 위험.
 * 이 모듈로 검색 결과를 "dev/biz root 하위 + 제외 폴더 미경유"로 한정한다.
 *
 * 성능: 폴더 메타(id→name,parent)는 거의 변하지 않으므로 프로세스 캐시 → 부모 walk 가 warmup 후 캐시 hit.
 */
import type { DriveClient, DriveFile } from './client.js';
import { DRIVE_ROOTS } from './settings.js';
import { isExcludedName } from './exclude.js';

const ROOT_IDS = new Set(DRIVE_ROOTS.map((r) => r.id));

// 폴더 메타 캐시 (id → {name, parent}). TTL 부여 — 영구 캐시면 폴더를 민감 분류(`06_증빙_PII` 등)로
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
 * 'ok'       : root 하위 + 제외 폴더 미경유 → 노출
 * 'excluded' : 제외 폴더(PII/계약/HR/deprecated/node_modules 등)를 경유 → 응답에서 제거
 * 'outside'  : root 에 닿지 못함(색인 대상 밖), 또는 폴더 조회 실패 → 보수적으로 제거
 */
export type SearchClass = 'ok' | 'excluded' | 'outside';

/**
 * 파일의 parents 에서 root 까지 올라가며 분류하고 폴더 경로(root 하위)를 돌려준다 — 도구 결과와 직원별 폴더 scope 필터용.
 * parents[0] 만 따라간다(최대 12 hop). path 는 폴더만(파일명 제외), root 바로 아래부터, 예: "Clients/Acme".
 * cls!=='ok' 면 path 무의미. 폴더 조회가 실패하면 'outside'(숨김) — 도구는 모를 때 보여 주지 않는다.
 */
export async function classifyAndPath(
  drive: DriveClient,
  parents: string[] | undefined,
): Promise<{ cls: SearchClass; path: string }> {
  const names: string[] = [];
  let chain = parents;
  for (let hop = 0; hop < 12 && chain && chain.length > 0; hop++) {
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
 * 폴더 자신을 분류 — list_drive_folder 의 시작 폴더 검사용.
 * root 폴더면 'ok'(path ''), 그 밖에는 자기 이름이 제외 대상인지 본 뒤 부모 체인을 classifyAndPath 로 분류한다.
 * path 는 root 바로 아래부터 이 폴더까지(자기 이름 포함). 예: root/01_고객사/Acme → "01_고객사/Acme".
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
  if (parent.cls !== 'ok') return { cls: parent.cls, path: '' };
  return { cls: 'ok', path: parent.path ? `${parent.path}/${d.name ?? ''}` : d.name ?? '' };
}
