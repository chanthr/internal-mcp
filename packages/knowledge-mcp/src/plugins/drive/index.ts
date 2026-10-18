/**
 * Google Drive plugin — keyword search, read, folder listing, and semantic (vector) search.
 *
 * Credentials (any one):
 *   GOOGLE_SERVICE_ACCOUNT_KEY (JSON) | GOOGLE_APPLICATION_CREDENTIALS (file path)
 *   | GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
 * Semantic search also needs QDRANT_URL and OPENAI_API_KEY, and an index (`knowledge-mcp drive reindex`).
 * Scope comes from the config file: drive.roots (folders to search) and drive.excludeFolders.
 */
import { definePlugin } from '../../plugin/define.js';
import { isSet as has } from '../../core/env.js';
import { searchDriveTool } from './tools/search_drive.js';
import { readDriveFileTool } from './tools/read_drive_file.js';
import { listDriveFolderTool } from './tools/list_drive_folder.js';
import { semanticSearchDriveTool } from './tools/semantic_search_drive.js';

/** Drive API credentials present. Matches client.ts. */
export function driveConfigured(): boolean {
  if (has(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)) return true;
  if (has(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.DRIVE_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.DRIVE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN;
  return has(id) && has(secret) && has(refresh);
}

/** semantic_search_drive — Qdrant (vectors) and OpenAI (embeddings). Independent of the Drive API credentials. */
export function semanticConfigured(): boolean {
  return has(process.env.QDRANT_URL) && has(process.env.OPENAI_API_KEY);
}

const DRIVE_CREDS = 'set GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN';
const driveOnly = () => driveConfigured() || DRIVE_CREDS;

export const drivePlugin = definePlugin({
  id: 'drive',
  description: 'Google Drive search, read and semantic search',
  // On when either half works: the Drive API tools, or semantic search over an existing index.
  enabled: () => driveConfigured() || semanticConfigured() || `${DRIVE_CREDS} (or QDRANT_URL + OPENAI_API_KEY)`,
  tools: [
    { ...searchDriveTool, enabled: driveOnly },
    { ...readDriveFileTool, enabled: driveOnly },
    { ...listDriveFolderTool, enabled: driveOnly },
    { ...semanticSearchDriveTool, enabled: () => semanticConfigured() || 'missing env QDRANT_URL, OPENAI_API_KEY' },
  ],
  instructions:
    'Drive: meaning/concept questions → semantic_search_drive; keyword or file name → search_drive; ' +
    '"list all" / folder contents → list_drive_folder(folderName). When a chunk lacks context, read_drive_file with the File ID ' +
    '(fileIds=[...] reads several at once).',
  async start({ log }) {
    // Incremental Drive → Qdrant sync. Needs Drive credentials, Qdrant and an embedding key; DRIVE_SYNC_ENABLED=false turns it off.
    // (Without OPENAI_API_KEY every changed file would fail and be dropped.)
    if (process.env.DRIVE_SYNC_ENABLED === 'false' || !driveConfigured() || !semanticConfigured()) return;
    const { ensureCollection } = await import('./qdrant.js');
    const { startDriveSyncScheduler } = await import('./sync.js');
    try {
      await ensureCollection(); // a fresh deploy otherwise fails its first sync silently
    } catch (e) {
      log('ensureCollection failed (sync keeps trying):', e);
    }
    startDriveSyncScheduler(parseInt(process.env.DRIVE_SYNC_INTERVAL_MIN || '30', 10));
  },
  commands: {
    reindex: {
      description: 'full Drive → Qdrant index (--dry-run, --recreate, --root <id>, --dev-only, --biz-only)',
      run: async (args) => (await import('./reindex.js')).runReindex(args),
    },
    'get-token': {
      description: 'sign in with Google and print a Drive refresh token (GOOGLE_OAUTH_CLIENT_ID/SECRET)',
      run: async () => (await import('./get_token.js')).runGetToken(),
    },
  },
});
