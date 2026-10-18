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
import type { drive_v3 } from 'googleapis';
import { getDriveClient } from './client.js';
import { indexFile, deleteFileVectors, SUPPORTED_MIMES, DRIVE_ROOTS } from './indexer.js';
import { getSyncToken, setSyncToken } from './sync_state.js';
import { isExcludedPath } from './exclude.js';
import { getFolderMeta } from './path.js';

/**
 * fileId 의 parent chain 을 root 까지 추적해 path + source 복원. dev/biz 외면 null.
 * 폴더 hop 은 drive_path.getFolderMeta(프로세스 캐시·10분 TTL)로 조회 — 변경 파일들이 조상 폴더를
 * 공유하므로 warmup 후 캐시 hit 로 Drive API 왕복이 급감(sync 지연·쿼터 절감). 파일 자신의 parents 만
 * 매번 조회(변경 파일이라 캐시 무의미). 폴더 조회 실패 시 getFolderMeta 가 빈 값 → walk 종료(graceful).
 */
async function resolvePathAndSource(
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
): Promise<{ path: string; source: 'dev' | 'biz' } | null> {
  const folders: string[] = [];
  let parents: string[] | undefined = (
    await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true })
  ).data.parents ?? undefined;

  for (let hop = 0; hop < 12 && parents && parents.length > 0; hop++) {
    const pid = parents[0];
    const root = DRIVE_ROOTS.find((r) => r.id === pid);
    if (root) return { path: [...folders, fileName].join('/'), source: root.source };
    const meta = await getFolderMeta(drive, pid);
    if (meta.name) folders.unshift(meta.name);
    parents = meta.parent ? [meta.parent] : undefined;
  }
  return null; // dev/biz root 하위 아님 → skip
}

export interface SyncResult {
  status: string;
  changed: number;
  deleted: number;
  skipped: number;
  errored?: number;
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
  let cursor: string | undefined = token;

  while (cursor) {
    const data: drive_v3.Schema$ChangeList = (
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
