/**
 * list_drive_folder — Drive 폴더 자식 list (배치 + 재귀 depth).
 *
 * 배치/재귀: 폴더 N개·하위 트리를 1회 호출로. 에이전트가 폴더마다 순차 호출(= per-call
 *   네트워크 floor + 그 사이 LLM 추론 턴 ×N)하던 것을 1회로 접어 체감 지연을 N→1 로 줄인다.
 *   read_drive_file 의 fileIds 배치와 같은 패턴(서버가 Drive I/O 를 자기↔구글 빠른 망에서 병렬).
 *
 *   - folderNames[] / folderIds[] : 서로 다른 위치의 폴더 여러 개를 병렬 list.
 *   - depth (1~3)                 : 한 폴더의 하위 트리를 N단계까지 한 번에.
 *     예) 고객사 10곳 + 각 폴더 문서 → list_drive_folder({ folderName: "01_고객사", depth: 2 }).
 *
 * 보안: 시작 폴더는 색인 root 하위이고 제외 폴더(PII·계약·HR 등)를 거치지 않을 때만 연다(read_drive_file 과 동일 가드).
 *   이름으로 찾을 때도 root 하위 후보만 고른다. 재귀 walk 는 제외 폴더로 확산하지 않는다
 *   (해당 폴더는 이름만 표기하고 자식 미전개 — excluded:true).
 *
 * 안전장치: 총 폴더 방문(=Drive list 호출) 상한 MAX_FOLDER_VISITS — 깊고 넓은 트리의 호출 폭발 방지.
 */
import { z } from 'zod';
import { getDriveClient, escapeDriveQuery } from '../integrations/drive.js';
import { getAuth } from '../lib/context.js';
import { isExcludedName } from '../lib/exclude.js';
import { allowedDriveFolders, isPathInScope } from '../lib/scope.js';
import { classifyFolder } from '../lib/drive_path.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FOLDER_VISITS = 120; // 재귀 폭발 방지 — 총 폴더 방문(list 호출) 상한

export const listDriveFolderTool = {
  name: 'list_drive_folder',
  description:
    'Google Drive 폴더의 자식 파일·폴더 list. folderId/folderName(단일) 또는 folderIds/folderNames(여러 개 한 번에). ' +
    '**"고객사 전부/명단", "X 폴더에 뭐 있어" 같은 전수·구조 질문은 semantic_search 가 아니라 이 도구.** ' +
    '**여러 폴더거나 하위까지 봐야 하면 폴더마다 따로 호출하지 말고 한 번에 묶어라:** ' +
    'folderNames=[...] 로 여러 폴더를 병렬, 또는 depth(1~3)로 하위 트리까지 한 번에 ' +
    '(예: 고객사 10곳 + 각 폴더 문서 → folderName="01_고객사", depth=2). ' +
    'folderName 은 이름으로 ID 를 자동 resolve. 결과의 id 로 read_drive_file 호출해 원문 read.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      folderId: {
        type: 'string',
        description: 'Drive folder ID (단일). "root" = My Drive 최상위.',
      },
      folderName: {
        type: 'string',
        description: '폴더 이름 (단일, 예: "01_고객사"). ID 를 몰라도 이름으로 조회.',
      },
      folderIds: {
        type: 'array',
        items: { type: 'string' },
        description: '여러 folder ID 를 한 번에 병렬 list (1~20). 순차 호출보다 훨씬 빠름.',
      },
      folderNames: {
        type: 'array',
        items: { type: 'string' },
        description: '여러 폴더 이름을 한 번에 병렬 list (1~20). 순차 호출보다 훨씬 빠름.',
      },
      depth: {
        type: 'number',
        description:
          '재귀 깊이 1~3. default 1(직속 자식만). 2=손자까지, 3=증손자까지 — 하위 트리를 1회 호출로 받는다.',
      },
      pageSize: {
        type: 'number',
        description: '폴더당 최대 자식 수 (1-200). default 50.',
      },
    },
  },
};

const inputSchema = z
  .object({
    folderId: z.string().min(1).optional(),
    folderName: z.string().min(1).optional(),
    folderIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    folderNames: z.array(z.string().min(1)).min(1).max(20).optional(),
    depth: z.number().int().min(1).max(3).default(1),
    pageSize: z.number().int().min(1).max(200).default(50),
  })
  .refine(
    (v) => v.folderId || v.folderName || v.folderIds?.length || v.folderNames?.length,
    { message: 'folderId / folderName / folderIds / folderNames 중 하나는 필수' },
  );

type DriveClient = ReturnType<typeof getDriveClient>;
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

export async function handleListDriveFolder(args: unknown) {
  const auth = getAuth();
  const { folderId, folderName, folderIds, folderNames, depth, pageSize } = inputSchema.parse(args);
  const drive = getDriveClient();
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
            return { folderId: spec.id, folderName: null, error: '[forbidden] 접근 범위 밖 폴더입니다 (색인 대상 root 밖 / 민감 폴더).' };
          }
          fid = spec.id;
          rootPath = c.path;
        } else {
          const resolved = await resolveFolderId(drive, spec.name!);
          if (!resolved) {
            return { folderId: null, folderName: spec.name, error: `폴더 "${spec.name}" 을 찾지 못함 (색인 대상 root 하위만 조회)` };
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
