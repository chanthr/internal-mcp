/**
 * search_drive(query, mode?, mimeType?, pageSize?): searches files in Google Drive.
 *
 * Permission group: drive. Folder scope comes from app_users.allowed_drive_folders. Drive access uses the server's credentials.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient, escapeDriveQuery } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { classifyAndPath, isReadableClass, type SearchClass } from '../path.js';
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
      // Full-text results come back by relevance when no order is given. Drive rejects or ignores an explicit
      // order on fullText queries, and newest-first buried the best match. Title search stays newest-first.
      ...(mode === 'fullText' ? {} : { orderBy: 'modifiedTime desc' }),
      // Search shared drives too. Without this, results are always 0 when the root is a shared drive.
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

    // Security: remove sensitive/excluded folders (PII, contracts, HR, deprecated) and anything outside the index, then apply
    // the per-user Drive folder scope.
    // For a folder result, the folder itself is checked too. Checking only the parent would let an excluded folder (e.g. HR)
    // show up by name, and would drop an allowed folder itself because its parent path is outside the scope.
    const folderScope = allowedDriveFolders(auth);
    const cps = await Promise.all(
      raw.map(async (f): Promise<{ cls: SearchClass; path: string }> => {
        const parent = await classifyAndPath(drive, f.parents);
        if (f.mimeType !== FOLDER_MIME || !isReadableClass(parent.cls)) return parent;
        if (isExcludedName(f.name)) return { cls: 'excluded', path: '' };
        return { cls: parent.cls, path: parent.path ? `${parent.path}/${f.name ?? ''}` : f.name ?? '' };
      }),
    );
    const files = raw.filter(
      (_, i) => isReadableClass(cps[i].cls) && (!folderScope || isPathInScope(cps[i].path, folderScope)),
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // The number of filtered-out items is not returned: a person outside the scope could enter a word and learn how many
            // files they cannot see contain it.
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
