/**
 * search_drive(query, mode?, mimeType?, pageSize?) — Google Drive 파일 검색.
 *
 * Role: 모든 role 허용 (admin/engineer/viewer). Drive 권한은 server-side.
 */
import { z } from 'zod';
import { getDriveClient, escapeDriveQuery } from '../integrations/drive.js';
import { getAuth } from '../lib/context.js';
import { allowedDriveFolders, isPathInScope } from '../lib/scope.js';
import { classifyAndPath } from '../lib/drive_path.js';

export const searchDriveTool = {
  name: 'search_drive',
  description:
    'Google Drive 에서 파일 검색. mode="title" 은 파일명, "fullText" 는 본문까지. ' +
    'Unified search across your indexed Drive assets. ' +
    '검색 범위는 설정한 Drive root 하위로 한정되며, 설정의 제외 폴더(excludeFolders)를 거치는 파일은 결과에서 빠진다. ' +
    'search → read_drive_file 순서로 사용.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '검색어' },
      mode: {
        type: 'string',
        enum: ['title', 'fullText'],
        description: '"title" 또는 "fullText". default "title" (신뢰성 ↑).',
      },
      mimeType: {
        type: 'string',
        description: '선택. 예: "text/markdown" 또는 "application/vnd.google-apps.folder"',
      },
      pageSize: {
        type: 'number',
        description: '최대 결과 수 (1-50). default 10.',
      },
    },
    required: ['query'],
  },
};

const inputSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(['title', 'fullText']).default('title'),
  mimeType: z.string().optional(),
  pageSize: z.number().int().min(1).max(50).default(10),
});

export async function handleSearchDrive(args: unknown) {
  const auth = getAuth();
  const { query, mode, mimeType, pageSize } = inputSchema.parse(args);

  const drive = getDriveClient();
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
