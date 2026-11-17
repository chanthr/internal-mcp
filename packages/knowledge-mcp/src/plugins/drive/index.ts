/**
 * Google Drive plugin — search by title or text, read, folder listing, and keeping Drive documents in the search index.
 *
 * Credentials (any one):
 *   GOOGLE_SERVICE_ACCOUNT_KEY (JSON) | GOOGLE_APPLICATION_CREDENTIALS (file path)
 *   | GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
 * Search over the index (search_knowledge) is the `knowledge` plugin; this plugin feeds it and keeps it in sync.
 * Scope comes from the config file: drive.roots (folders to search) and drive.excludeFolders.
 */
import { definePlugin } from '../../plugin/define.js';
import { isSet as has } from '../../core/env.js';
import { indexAvailable } from './indexer.js';
import { searchDriveTool } from './tools/search_drive.js';
import { readDriveFileTool } from './tools/read_drive_file.js';
import { listDriveFolderTool } from './tools/list_drive_folder.js';

/** Drive API credentials present. Matches client.ts. */
export function driveConfigured(): boolean {
  if (has(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)) return true;
  if (has(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.DRIVE_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.DRIVE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN;
  return has(id) && has(secret) && has(refresh);
}

const DRIVE_CREDS = 'set GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN';
const driveOnly = () => driveConfigured() || DRIVE_CREDS;

export const drivePlugin = definePlugin({
  id: 'drive',
  description: 'Google Drive search, read and folder listing; Drive documents join the search index',
  enabled: () => driveConfigured() || DRIVE_CREDS,
  tools: [
    { ...searchDriveTool, enabled: driveOnly },
    { ...readDriveFileTool, enabled: driveOnly },
    { ...listDriveFolderTool, enabled: driveOnly },
  ],
  instructions:
    'Drive: questions about what documents say → search_knowledge (the index); a file by its name, or the newest files → search_drive; ' +
    '"list all" / folder contents → list_drive_folder(folderName). read_drive_file reads a whole Drive file by its id ' +
    '(fileIds=[...] reads several at once).',
  async start({ log }) {
    // Keeps the index in step with Drive: builds it on the first run, then applies changes on a timer. Needs Drive
    // credentials. With Qdrant as the store it also needs an embedding model; the built-in index does not.
    // DRIVE_SYNC_ENABLED=false turns it off.
    if (process.env.DRIVE_SYNC_ENABLED === 'false' || !driveConfigured() || !indexAvailable()) return;
    const { ensureCollection } = await import('./qdrant.js');
    const { startDriveSyncScheduler } = await import('./sync.js');
    try {
      await ensureCollection(); // a fresh deploy otherwise fails its first sync silently
    } catch (e) {
      log('ensureCollection failed (sync keeps trying):', e);
    }
    startDriveSyncScheduler(parseInt(process.env.DRIVE_SYNC_INTERVAL_MIN || '30', 10));
  },
  async catchUp({ log }) {
    // A stdio session has no scheduler, so without this a local-only setup would never get an index or see new
    // documents. One pass per session start; a lock keeps parallel sessions from doing the same work.
    if (process.env.DRIVE_SYNC_ENABLED === 'false' || !driveConfigured() || !indexAvailable()) return;
    const { ensureCollection } = await import('./qdrant.js');
    const { runSyncOnce } = await import('./sync.js');
    await ensureCollection();
    const r = await runSyncOnce();
    log(r ? `sync: ${r.status} · changed=${r.changed} deleted=${r.deleted}` : 'sync: another process is already syncing');
  },
  commands: {
    reindex: {
      description: 'rebuild the whole search index (--dry-run, --recreate, --root <id>, --source <label>). The server builds the first one itself',
      run: async (args) => (await import('./reindex.js')).runReindex(args),
    },
    'get-token': {
      description: 'sign in with Google and print a Drive refresh token (GOOGLE_OAUTH_CLIENT_ID/SECRET)',
      run: async () => (await import('./get_token.js')).runGetToken(),
    },
  },
});
