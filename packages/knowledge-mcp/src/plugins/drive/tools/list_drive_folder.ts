/**
 * list_drive_folder — Drive 폴더 자식 list (배치 + 재귀 depth).
 *
 * 배치/재귀: 폴더 N개·하위 트리를 1회 호출로. 에이전트가 폴더마다 순차 호출(= per-call
 *   네트워크 floor + 그 사이 LLM 추론 턴 ×N)하던 것을 1회로 접어 체감 지연을 N→1 로 줄인다.
 *   read_drive_file 의 fileIds 배치와 같은 패턴(서버가 Drive I/O 를 자기↔구글 빠른 망에서 병렬).
 *
 *   - folderNames[] / folderIds[] : 서로 다른 위치의 폴더 여러 개를 병렬 list.
 *   - depth (1~3)                 : 한 폴더의 하위 트리를 N단계까지 한 번에.
 *     예) 고객사 폴더 10곳 + 각 폴더 문서 → list_drive_folder({ folderName: "Clients", depth: 2 }).
 *
 * 보안: 시작 폴더는 색인 root 하위이고 제외 폴더(PII·계약·HR 등)를 거치지 않을 때만 연다(read_drive_file 과 동일 가드).
 *   이름으로 찾을 때도 root 하위 후보만 고른다. 재귀 walk 는 제외 폴더로 확산하지 않는다
 *   (해당 폴더는 이름만 표기하고 자식 미전개 — excluded:true).
 *
 * 안전장치: 총 폴더 방문(=Drive list 호출) 상한 MAX_FOLDER_VISITS — 깊고 넓은 트리의 호출 폭발 방지.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient, escapeDriveQuery } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { isExcludedName } from '../exclude.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { classifyFolder } from '../path.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FOLDER_VISITS = 120; // 재귀 폭발 방지 — 총 폴더 방문(list 호출) 상한

const DESCRIPTION =
  'Lists the child files and folders of a Google Drive folder. Use folderId/folderName (one) or folderIds/folderNames (several at once). ' +
  '**For exhaustive or structural questions such as "all clients / the client list" or "what is in folder X", use this tool, not semantic_search.** ' +
  '**If you need several folders or their subfolders, do not call once per folder; batch them in one call:** ' +
  'folderNames=[...] lists several folders in parallel, or depth (1~3) returns the subtree in the same call ' +
  '(e.g. 10 client folders + the documents in each → folderName="Clients", depth=2). ' +
  'folderName resolves the ID from the name automatically. Call read_drive_file with a result id to read the original.';

const inputSchema = z
  .object({
    folderId: z.string().min(1).optional().describe('Drive folder ID (one). "root" = top level of My Drive.'),
    folderName: z.string().min(1).optional().describe('Folder name (one, e.g. "Clients"). Looks the folder up by name when you do not know the ID.'),
    folderIds: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe('List several folder IDs in parallel in one call (1~20). Much faster than sequential calls.'),
    folderNames: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe('List several folder names in parallel in one call (1~20). Much faster than sequential calls.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe('Recursion depth 1~3. default 1 (direct children only). 2 = down to grandchildren, 3 = down to great-grandchildren; returns the subtree in a single call.'),
    pageSize: z.number().int().min(1).max(200).default(50).describe('Max children per folder (1-200). default 50.'),
  })
  .refine(
    (v) => v.folderId || v.folderName || v.folderIds?.length || v.folderNames?.length,
    { message: 'One of folderId / folderName / folderIds / folderNames is required' },
  );

export const listDriveFolderTool = defineTool({
  name: 'list_drive_folder',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleListDriveFolder(args),
});

type DriveClient = Awaited<ReturnType<typeof getDriveClient>>;
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

type TreeNode = {
  id: string | null | undefined;
  name: string | null | undefined;
  mimeType: string | null | undefined;
  isFolder: boolean;
  modifiedTime?: string | null;
  size?: string | null;
  excluded?: true; // EXCLUDED 폴더 — 자식 미전개(보안)
  truncated?: true; // 방문 cap 도달로 자식 생략
  childrenTruncated?: true; // pageSize 초과 자식이 더 있음(전수 아님 — pageSize 늘리거나 드릴다운)
  children?: TreeNode[];
};

type Budget = { visits: number };

/**
 * folderName → 색인 root 하위의 열 수 있는 폴더 (Shared Drive 포함). 못 찾으면 null.
 * 같은 이름 폴더가 여럿이면 root 밖·제외 경로 후보를 건너뛰고 처음 'ok' 인 것을 고른다.
 */
async function resolveFolderId(drive: DriveClient, name: string): Promise<{ id: string; path: string } | null> {
  const res = await drive.files.list({
    q: `name = '${escapeDriveQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 10,
    ...ALL_DRIVES,
  });
  for (const f of res.data.files ?? []) {
    if (!f.id) continue;
    const c = await classifyFolder(drive, f.id);
    if (c.cls === 'ok') return { id: f.id, path: c.path };
  }
  return null;
}

/**
 * 폴더 fid 의 자식을 list 하고, depthLeft 가 남으면 (제외 폴더를 제외하고) 자식 폴더를 병렬 재귀.
 * 같은 레벨 폴더는 Promise.all 로 동시에 펼친다. budget 으로 총 방문 수를 캡.
 */
async function walkFolder(
  drive: DriveClient,
  fid: string,
  depthLeft: number,
  pageSize: number,
  budget: Budget,
): Promise<{ children: TreeNode[]; hasMore: boolean }> {
  const res = await drive.files.list({
    q: `'${escapeDriveQuery(fid)}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
    pageSize,
    orderBy: 'folder, name',
    ...ALL_DRIVES,
  });

  // pageSize 초과 자식이 더 있으면 hasMore — 예전엔 조용히 잘려 "전수 목록" 을 오인할 수 있었다.
  const hasMore = !!res.data.nextPageToken;
  const nodes: TreeNode[] = (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    isFolder: f.mimeType === FOLDER_MIME,
    modifiedTime: f.modifiedTime,
    size: f.size,
  }));

  if (depthLeft <= 1) return { children: nodes, hasMore };

  // 자식 폴더 중 제외(PII/계약/HR/deprecated 등) 아닌 것만 재귀. 제외 폴더는 이름만 남기고 미전개.
  const toRecurse = nodes.filter((n) => {
    if (!n.isFolder) return false;
    if (isExcludedName(n.name)) {
      n.excluded = true;
      return false;
    }
    return true;
  });

  await Promise.all(
    toRecurse.map(async (n) => {
      // check + increment 는 동기(중간 await 없음) → 병렬 콜백 간에도 cap 정확.
      if (budget.visits >= MAX_FOLDER_VISITS) {
        n.truncated = true;
        return;
      }
      budget.visits += 1;
      const sub = await walkFolder(drive, n.id!, depthLeft - 1, pageSize, budget);
      n.children = sub.children;
      if (sub.hasMore) n.childrenTruncated = true;
    }),
  );

  return { children: nodes, hasMore };
}

/** 재귀 트리를 직원별 Drive 폴더 scope 로 후처리 필터. 폴더는 자식이 scope 에 걸리면 유지(하위 도달 보장). */
function filterTreeByScope(nodes: TreeNode[], parentPath: string, scope: string[]): TreeNode[] {
  return nodes.filter((n) => {
    const p = parentPath ? `${parentPath}/${n.name ?? ''}` : n.name ?? '';
    if (n.isFolder) {
      if (n.children) n.children = filterTreeByScope(n.children, p, scope);
      return isPathInScope(p, scope) || (n.children !== undefined && n.children.length > 0);
    }
    return isPathInScope(p, scope);
  });
}

export async function handleListDriveFolder(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { folderId, folderName, folderIds, folderNames, depth, pageSize } = args;
  const drive = await getDriveClient();
  const folderScope = allowedDriveFolders(auth);

  // 단수 + 배치 입력을 루트 명세로 통합.
  const rootSpecs: Array<{ id?: string; name?: string }> = [];
  if (folderId) rootSpecs.push({ id: folderId });
  if (folderName) rootSpecs.push({ name: folderName });
  for (const id of folderIds ?? []) rootSpecs.push({ id });
  for (const name of folderNames ?? []) rootSpecs.push({ name });

  const budget: Budget = { visits: rootSpecs.length }; // 루트도 방문 1회로 카운트

  try {
    const roots = await Promise.all(
      rootSpecs.map(async (spec) => {
        let fid: string;
        let rootPath: string;
        if (spec.id) {
          // 시작 폴더 가드 — 색인 root 하위 + 제외 폴더 미경유일 때만 연다.
          const c = await classifyFolder(drive, spec.id);
          if (c.cls !== 'ok') {
            return { folderId: spec.id, folderName: null, error: '[forbidden] This folder is outside the allowed scope (outside the indexed roots / sensitive folder).' };
          }
          fid = spec.id;
          rootPath = c.path;
        } else {
          const resolved = await resolveFolderId(drive, spec.name!);
          if (!resolved) {
            return { folderId: null, folderName: spec.name, error: `Folder "${spec.name}" not found (only folders under the indexed roots are searched)` };
          }
          fid = resolved.id;
          rootPath = resolved.path;
        }
        const rootWalk = await walkFolder(drive, fid, depth, pageSize, budget);
        let items = rootWalk.children;
        // 직원별 Drive 폴더 scope 후처리 (admin·미설정 = 전체). root 기준 경로로 트리 필터.
        if (folderScope) items = filterTreeByScope(items, rootPath, folderScope);
        return {
          folderId: fid,
          folderName: spec.name ?? null,
          count: items.length,
          childrenTruncated: rootWalk.hasMore || undefined,
          items,
        };
      }),
    );

    const truncated = budget.visits >= MAX_FOLDER_VISITS;

    // 하위호환: 단일 루트 + depth=1 + 배치 미사용 → 기존 응답 형식 그대로(기존 호출자 무손상).
    const isLegacy = !folderIds && !folderNames && depth === 1 && rootSpecs.length === 1;
    if (isLegacy) {
      const r = roots[0];
      if ('error' in r && r.error) {
        return { content: [{ type: 'text' as const, text: `[error] ${r.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { rootCount: roots.length, depth, folderVisits: budget.visits, truncated, roots },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `[error] ${msg}` }], isError: true };
  }
}
