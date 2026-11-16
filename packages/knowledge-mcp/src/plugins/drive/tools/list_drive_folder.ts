/**
 * list_drive_folder: lists the children of a Drive folder (batch + recursive depth).
 *
 * Batch/recursion: N folders or a subtree in one call. An agent used to call once per folder in sequence (= the per-call
 *   network floor plus an LLM reasoning turn in between, ×N). Folding that into one call cuts perceived latency from N to 1.
 *   Same pattern as the fileIds batch of read_drive_file (the server runs Drive I/O in parallel over its fast link to Google).
 *
 *   - folderNames[] / folderIds[] : lists several folders in different locations in parallel.
 *   - depth (1~3)                 : walks one folder's subtree down to N levels in one call.
 *     e.g. 10 customer folders plus the documents in each → list_drive_folder({ folderName: "Clients", depth: 2 }).
 *
 * Security: the start folder is opened only when it is under the indexed root and its path does not pass through an
 *   excluded folder (PII, contracts, HR etc.), the same guard as read_drive_file.
 *   Lookup by name also picks only candidates under the root. The recursive walk does not spread into excluded folders
 *   (such a folder is listed by name only and its children are not expanded: excluded:true).
 *
 * Safety limit: MAX_FOLDER_VISITS caps the total folder visits (= Drive list calls), which prevents a call explosion on
 * deep and wide trees.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient, escapeDriveQuery } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { isExcludedName } from '../exclude.js';
import { allowedDriveFolders, isPathInScope, isScopeAncestor } from '../../../core/scope.js';
import { classifyFolder, isReadableClass } from '../path.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FOLDER_VISITS = 120; // prevents recursion blow-up: cap on total folder visits (list calls)

const DESCRIPTION =
  'Lists the child files and folders of a Google Drive folder. Use folderId/folderName (one) or folderIds/folderNames (several at once). ' +
  '**For exhaustive or structural questions such as "all clients / the client list" or "what is in folder X", use this tool, not semantic_search.** ' +
  '**If you need several folders or their subfolders, do not call once per folder; batch them in one call:** ' +
  'folderNames=[...] lists several folders in parallel, or depth (1~3) returns the subtree in the same call ' +
  '(e.g. 10 client folders + the documents in each → folderName="Clients", depth=2). ' +
  'folderName resolves the ID from the name automatically. Call read_drive_file with a result id to read the original.';

const inputSchema = z
  .object({
    folderId: z.string().min(1).optional().describe('Drive folder ID (one). Only folders under the indexed roots open.'),
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
  excluded?: true; // EXCLUDED folder: children not expanded (security)
  truncated?: true; // children omitted because the visit cap was reached
  childrenTruncated?: true; // more children exist beyond pageSize (not a full list: raise pageSize or drill down)
  children?: TreeNode[];
};

type Budget = { visits: number };

/**
 * folderName → an openable folder under the indexed root (Shared Drives included). null if not found.
 * When several folders share the name, candidates outside the root or on an excluded path are skipped and the first
 * 'ok' one is picked.
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
    if (isReadableClass(c.cls)) return { id: f.id, path: c.path };
  }
  return null;
}

/**
 * Lists the children of folder fid and, while depthLeft remains, recurses into the child folders in parallel (excluded
 * folders are skipped).
 * Folders on the same level are expanded concurrently with Promise.all. budget caps the total number of visits.
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

  // hasMore when more children exist beyond pageSize. Previously the list was cut silently and could be mistaken for a
  // full list.
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

  // Recurse only into child folders that are not excluded (PII, contracts, HR, deprecated etc.). Excluded folders keep
  // their name only and are not expanded.
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
      // check + increment is synchronous (no await in between) → the cap stays exact across parallel callbacks.
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

/**
 * Post-filters the recursive tree by the per-user Drive folder scope. A folder is kept when a child falls in the scope or
 * when it is an ancestor of an allowed folder.
 * Ancestors must stay so that walking down one level at a time with depth=1 still reaches the allowed folder.
 */
function filterTreeByScope(nodes: TreeNode[], parentPath: string, scope: string[]): TreeNode[] {
  return nodes.filter((n) => {
    const p = parentPath ? `${parentPath}/${n.name ?? ''}` : n.name ?? '';
    if (n.isFolder) {
      if (n.children) n.children = filterTreeByScope(n.children, p, scope);
      return isPathInScope(p, scope) || isScopeAncestor(p, scope) || (n.children !== undefined && n.children.length > 0);
    }
    return isPathInScope(p, scope);
  });
}

export async function handleListDriveFolder(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { folderId, folderName, folderIds, folderNames, depth, pageSize } = args;
  const drive = await getDriveClient();
  const folderScope = allowedDriveFolders(auth);

  // Merge the single and batch inputs into one list of root specs.
  const rootSpecs: Array<{ id?: string; name?: string }> = [];
  if (folderId) rootSpecs.push({ id: folderId });
  if (folderName) rootSpecs.push({ name: folderName });
  for (const id of folderIds ?? []) rootSpecs.push({ id });
  for (const name of folderNames ?? []) rootSpecs.push({ name });

  const budget: Budget = { visits: rootSpecs.length }; // each root also counts as one visit

  try {
    const roots = await Promise.all(
      rootSpecs.map(async (spec) => {
        let fid: string;
        let rootPath: string;
        if (spec.id) {
          // Start folder guard: open only when under the indexed root and not passing through an excluded folder.
          const c = await classifyFolder(drive, spec.id);
          if (!isReadableClass(c.cls)) {
            return { folderId: spec.id, folderName: null, error: '[forbidden] This folder is outside the allowed scope (not shared with this server, or a sensitive folder).' };
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
        // Per-user Drive folder scope post-filter (admin or unset = all). Filters the tree by root-relative paths.
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

    // Backward compatibility: single root + depth=1 + no batch → same response format as before (existing callers unaffected).
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
