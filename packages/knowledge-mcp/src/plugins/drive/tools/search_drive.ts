/**
 * search_drive(query, mode?, mimeType?, pageSize?) — Google Drive 파일 검색.
 *
 * 권한 그룹: drive. 폴더 범위는 app_users.allowed_drive_folders. Drive 접근은 서버 자격증명.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient, escapeDriveQuery } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { classifyAndPath, type SearchClass } from '../path.js';
import { isExcludedName } from '../exclude.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const DESCRIPTION =
  'Searches files in Google Drive. mode="title" matches file names; "fullText" also matches the content. ' +
  'Unified search across your indexed Drive assets. ' +
  'Search is limited to the configured Drive roots, and files under the configured excluded folders (excludeFolders) are left out of the results. ' +
  'Use search first, then read_drive_file.';

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  mode: z.enum(['title', 'fullText']).default('title').describe('"title" or "fullText". default "title" (more reliable).'),
  mimeType: z.string().optional().describe('Optional. e.g. "text/markdown" or "application/vnd.google-apps.folder"'),
  pageSize: z.number().int().min(1).max(50).default(10).describe('Max number of results (1-50). default 10.'),
});

export const searchDriveTool = defineTool({
  name: 'search_drive',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSearchDrive(args),
});

export async function handleSearchDrive(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { query, mode, mimeType, pageSize } = args;

  const drive = await getDriveClient();
  const escaped = escapeDriveQuery(query);
  let q = mode === 'fullText' ? `fullText contains '${escaped}'` : `name contains '${escaped}'`;
  if (mimeType) {
    q += ` and mimeType = '${escapeDriveQuery(mimeType)}'`;
  }
  q += ' and trashed = false';

  try {
    const res = await drive.files.list({
      q,
      fields:
        'files(id, name, mimeType, parents, modifiedTime, size, webViewLink, owners(emailAddress))',
      pageSize,
      orderBy: 'modifiedTime desc',
      // 공유 드라이브까지 찾는다. 없으면 root 가 공유 드라이브일 때 결과가 늘 0건이다.
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const raw = (res.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents ?? undefined,
      modifiedTime: f.modifiedTime,
      size: f.size,
      viewUrl: f.webViewLink,
      owners: (f.owners || []).map((o) => o.emailAddress).filter(Boolean),
    }));

    // 보안: 민감/제외 폴더(PII·계약·HR·deprecated)·색인 대상 밖 제거 + 직원별 Drive 폴더 scope.
    // 폴더 결과는 그 폴더 자신도 본다. 부모만 보면 제외 폴더(예: HR)가 이름으로 결과에 나오고,
    // 허용 폴더 자체는 부모 경로가 범위 밖이라 빠진다.
    const folderScope = allowedDriveFolders(auth);
    const cps = await Promise.all(
      raw.map(async (f): Promise<{ cls: SearchClass; path: string }> => {
        const parent = await classifyAndPath(drive, f.parents);
        if (f.mimeType !== FOLDER_MIME || parent.cls !== 'ok') return parent;
        if (isExcludedName(f.name)) return { cls: 'excluded', path: '' };
        return { cls: 'ok', path: parent.path ? `${parent.path}/${f.name ?? ''}` : f.name ?? '' };
      }),
    );
    const files = raw.filter(
      (_, i) => cps[i].cls === 'ok' && (!folderScope || isPathInScope(cps[i].path, folderScope)),
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // 걸러진 건수는 돌려주지 않는다 — 범위 밖 사람이 단어를 넣어 "못 보는 파일에 그 단어가 몇 개 있는지" 알 수 있다.
            { count: files.length, mode, query, files },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text' as const, text: `[error] ${msg}` }],
      isError: true,
    };
  }
}
