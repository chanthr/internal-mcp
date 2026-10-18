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
import { classifyAndPath } from '../path.js';

const DESCRIPTION =
  'Google Drive 에서 파일 검색. mode="title" 은 파일명, "fullText" 는 본문까지. ' +
  'Unified search across your indexed Drive assets. ' +
  '검색 범위는 설정한 Drive root 하위로 한정되며, 설정의 제외 폴더(excludeFolders)를 거치는 파일은 결과에서 빠진다. ' +
  'search → read_drive_file 순서로 사용.';

const inputSchema = z.object({
  query: z.string().min(1).describe('검색어'),
  mode: z.enum(['title', 'fullText']).default('title').describe('"title" 또는 "fullText". default "title" (신뢰성 ↑).'),
  mimeType: z.string().optional().describe('선택. 예: "text/markdown" 또는 "application/vnd.google-apps.folder"'),
  pageSize: z.number().int().min(1).max(50).default(10).describe('최대 결과 수 (1-50). default 10.'),
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
    const folderScope = allowedDriveFolders(auth);
    const cps = await Promise.all(raw.map((f) => classifyAndPath(drive, f.parents)));
    const files = raw.filter(
      (_, i) => cps[i].cls === 'ok' && (!folderScope || isPathInScope(cps[i].path, folderScope)),
    );
    const filtered = raw.length - files.length;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { count: files.length, mode, query, filteredOut: filtered, files },
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
