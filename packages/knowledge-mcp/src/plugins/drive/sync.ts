/**
 * Drive → Qdrant 증분 sync (polling).
 *
 * Drive Changes API 로 마지막 sync 이후 변경·추가·삭제된 .md 파일만 반영.
 * - 변경/추가: re-chunk + embed + upsert (idempotent — 같은 chunk_id)
 * - 삭제/trashed: Qdrant 에서 해당 file 의 chunk 전부 delete
 * - pageToken 영속화 (sync_state) → 다음 sync 기준
 *
 * startup 1회 (첫 실행 = token 초기화만) + setInterval(기본 30분).
 * graceful: 오류 시 로그만, server 영향 X.
 */
import type { DriveChangeList, DriveClient } from './client.js';
import { DriveApiError, getDriveClient } from './client.js';
import { indexFile, deleteFileVectors, SUPPORTED_MIMES, DRIVE_ROOTS } from './indexer.js';
import { getSyncToken, setSyncToken } from './sync_state.js';
import { isExcludedPath } from './exclude.js';
import { clearFolderMetaCache, getFolderMeta } from './path.js';
import { DRIVE_COLLECTION, getQdrantClient, type PointId } from './qdrant.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * parents 를 root 까지 추적해 path + source 복원. root 밖이면 null.
 * 폴더 hop 은 getFolderMeta(프로세스 캐시·10분 TTL) — 변경 파일들이 조상 폴더를 공유해 warmup 후 캐시 hit.
 * 폴더 조회 실패는 throw 한다. 호출부가 그 파일만 errored 로 두고 벡터는 지우지 않는다.
 */
async function resolveFromParents(
  drive: DriveClient,
  firstParents: string[] | null | undefined,
  fileName: string,
): Promise<{ path: string; source: 'dev' | 'biz' } | null> {
  const folders: string[] = [];
  let parents: string[] | undefined = firstParents ?? undefined;
  for (let hop = 0; hop < 12 && parents && parents.length > 0; hop++) {
    const pid = parents[0];
    const root = DRIVE_ROOTS.find((r) => r.id === pid);
    if (root) return { path: [...folders, fileName].join('/'), source: root.source };
    const meta = await getFolderMeta(drive, pid);
    if (meta.name) folders.unshift(meta.name);
    parents = meta.parent ? [meta.parent] : undefined;
  }
  return null; // root 하위 아님 → skip
}

async function resolvePathAndSource(drive: DriveClient, fileId: string, fileName: string) {
  const parents = (await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true })).data.parents;
  return resolveFromParents(drive, parents, fileName);
}

/**
 * 폴더를 옮기거나 이름을 바꾸면 Drive 변경 목록에는 그 폴더 한 건만 온다. 안의 파일은 변경으로 오지 않아
 * payload 의 file_path 가 옛 경로로 남고, 의미 검색의 폴더 권한과 제외 폴더 판정이 옛 경로로 이뤄진다.
 * 그래서 폴더 변경을 보면 색인된 파일마다 지금 경로를 다시 계산한다:
 *   지운 파일, 휴지통, root 밖, 제외 폴더 → 벡터 삭제. 경로나 이름이 바뀜 → 다시 색인. 그대로 → 그대로.
 * 파일 하나의 조회 실패는 errored 로 세고 넘어간다(지우지 않는다).
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
          await drive.files.get({ fileId: id, fields: 'id,name,mimeType,modifiedTime,size,trashed,parents', supportsAllDrives: true })
        ).data;
      } catch (e) {
        if (e instanceof DriveApiError && e.code === 404) {
          await deleteFileVectors(id);
          r.deleted++;
          continue;
        }
        throw e;
      }
      const resolved = f.trashed || !f.name ? null : await resolveFromParents(drive, f.parents, f.name);
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

export interface SyncResult {
  status: string;
  changed: number;
  deleted: number;
  skipped: number;
  errored?: number;
  /** Set when a folder changed and indexed paths were recomputed. */
  pathRefresh?: { checked: number; reindexed: number; deleted: number; errored: number };
}

export async function runIncrementalSync(): Promise<SyncResult> {
  const drive = await getDriveClient();
  const token = await getSyncToken();

  // 첫 실행 — startPageToken 저장만 (이후 변경부터 추적). 전체 색인은 knowledge-mcp drive reindex.
  if (!token) {
    const { data } = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    if (data.startPageToken) await setSyncToken(data.startPageToken);
    return { status: 'initialized', changed: 0, deleted: 0, skipped: 0 };
  }

  let changed = 0;
  let deleted = 0;
  let skipped = 0;
  let errored = 0;
  let foldersChanged = false;
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
      // 파일 1건 실패(Mathpix timeout·OpenAI 5xx 소진·깨진 docx 등)가 throw 하면 루프를 탈출해
      // runIncrementalSync 가 전체 throw → 그 tick 의 setSyncToken 이 호출 안 돼 pageToken 이
      // 전진 못 하고, 다음 tick 에 같은 깨진 파일에서 또 멈춘다(sync 영구 정체). per-file 격리로
      // 실패 파일만 errored 처리하고 나머지·토큰 전진은 계속한다.
      try {
        const f = ch.file;
        // 폴더 이동, 이름 변경, 휴지통, 영구 삭제(종류를 모름)는 안의 파일 경로를 바꾸지만 그 파일들은 변경으로 오지 않는다.
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
        // 제외: dev/biz 외 폴더 + 민감(PII/계약/HR/deprecated) + 개발 아티팩트(node_modules 등). SSOT: exclude.ts
        // 색인 대상 밖으로 옮겨졌거나 제외 폴더로 들어간 파일은 남아 있던 벡터를 지운다
        // (건너뛰기만 하면 옛 청크 본문이 semantic_search_drive 에 계속 나온다).
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
        console.error(
          `[drive-sync] 파일 색인 실패 (skip, 토큰은 전진): fileId=${ch.fileId ?? '?'} — ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (data.newStartPageToken) {
      await setSyncToken(data.newStartPageToken);
      break;
    }
    cursor = data.nextPageToken ?? undefined;
  }

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

let _started = false;
let _running = false;
let _timer: NodeJS.Timeout | null = null;

/**
 * startup 호출 — 1회 실행(첫 실행은 token init) + 주기 polling.
 *
 * setInterval 대신 **자기재귀 setTimeout** — 다음 tick 을 이전 sync 가 끝난 뒤에만 예약해
 * 한 주기가 간격을 초과해도 sync 가 겹치지 않게 한다(중복 임베딩·토큰 되감김 방지).
 * `_running` 재진입 가드는 이중 안전장치.
 */
export function startDriveSyncScheduler(intervalMin = 30): void {
  if (_started) return;
  _started = true;

  const run = async () => {
    if (_running) {
      console.error('[drive-sync] 이전 주기 진행 중 — 이번 tick 건너뜀');
      return;
    }
    _running = true;
    try {
      const r = await runIncrementalSync();
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
    _timer = setTimeout(() => void run().finally(scheduleNext), intervalMin * 60_000);
  };

  void run().finally(scheduleNext); // startup 1회 후 주기 시작
  console.error(`[drive-sync] scheduler 시작 — ${intervalMin}분 주기 (자기재귀 setTimeout · 재진입 가드)`);
}
