/**
 * Knowledge plugin: one search over everything that is indexed, and one tool to read a document from it.
 *
 * Sources that feed the index:
 *   - local folders (config `folders`, env KNOWLEDGE_FOLDERS): scanned by this plugin
 *   - Google Drive (the `drive` plugin): documents under drive.roots and documents shared by trusted owners
 *
 * Nothing has to be configured for search to work: the built-in index answers by keywords. An embedding model
 * (OPENAI_API_KEY, or EMBEDDING_BASE_URL for another provider) adds search by meaning on top. With Qdrant as the
 * store (QDRANT_URL) an embedding model is required, because Qdrant holds vectors only.
 */
import { definePlugin, type PluginState } from '../../plugin/define.js';
import { driveConfigured } from '../drive/index.js';
import { backfillVectors, indexAvailable } from '../drive/indexer.js';
import { EMBEDDING_MODEL } from '../drive/embeddings.js';
import { reembed } from './reembed.js';
import { DRIVE_COLLECTION, getLocalIndex } from '../drive/qdrant.js';
import { foldersConfigured, scanFolders, startFolderScans } from './folders.js';
import { searchKnowledgeTool } from './tools/search_knowledge.js';
import { readDocumentTool } from './tools/read_document.js';
import { cli } from '../../core/invocation.js';

/** Is there anything that feeds the index? */
function hasSource(): boolean {
  return foldersConfigured() || driveConfigured();
}

const HAD_FOLDERS = 'folders.configured';

/**
 * Should the folders be scanned? Yes while any is configured. When the last one was removed from the config, its
 * documents are still in the index: one pass removes them, and after that there is nothing to scan.
 */
async function shouldScan(state: PluginState, log: (...a: unknown[]) => void): Promise<boolean> {
  if (process.env.KNOWLEDGE_SCAN_ENABLED === 'false' || !indexAvailable()) return false;
  if (foldersConfigured()) {
    if (!(await state.get(HAD_FOLDERS))) await state.set(HAD_FOLDERS, true);
    return true;
  }
  if (await state.get(HAD_FOLDERS)) {
    const r = await scanFolders(log);
    if (r) {
      if (r.removed) log(`folders: none configured any more, removed ${r.removed} document(s) from the index`);
      await state.set(HAD_FOLDERS, false);
    }
  }
  return false;
}

export const knowledgePlugin = definePlugin({
  id: 'knowledge',
  description: 'Search and read the indexed documents (local folders, Google Drive)',
  enabled: () => {
    if (!hasSource()) return `add a local folder (${cli('setup folder <path>')}) or connect Google Drive`;
    if (!indexAvailable()) return 'with QDRANT_URL set, an embedding model is required: set OPENAI_API_KEY or EMBEDDING_BASE_URL (or remove QDRANT_URL to use the built-in index)';
    return true;
  },
  tools: [searchKnowledgeTool, readDocumentTool],
  instructions:
    'Knowledge base: for any question about what the team\'s documents say, call search_knowledge first. ' +
    'Results are passages; call read_document with a Document ID when you need the whole document. ' +
    'Each result shows the document date: say how old a figure is rather than presenting it as current.',
  async start({ state, log }) {
    // HTTP server: scan the folders now and then on a timer. KNOWLEDGE_SCAN_ENABLED=false turns it off.
    if (!(await shouldScan(state, log))) return;
    startFolderScans(parseInt(process.env.KNOWLEDGE_SCAN_INTERVAL_MIN || '10', 10), log);
  },
  async catchUp({ state, log }) {
    // stdio session: one scan at start, so files edited since the last session are searchable.
    if (!(await shouldScan(state, log))) return;
    const r = await scanFolders(log);
    if (r && (r.indexed || r.removed || r.errored)) log(`folders: indexed ${r.indexed} · removed ${r.removed} · errors ${r.errored}`);
  },
  commands: {
    scan: {
      description: 'index the local folders now (new and changed files, removes deleted ones)',
      run: async () => {
        const r = await scanFolders((...a) => console.error('[knowledge]', ...a));
        if (!r) return console.log('Another process is scanning. Try again when it has finished.');
        console.log(
          `Scanned ${r.folders} folder(s), ${r.files} file(s): indexed ${r.indexed}, unchanged ${r.unchanged}, no text ${r.skipped}, removed ${r.removed}, errors ${r.errored}` +
            (r.unreadable.length ? `\nCould not read: ${r.unreadable.join(', ')}` : ''),
        );
      },
    },
    reembed: {
      description: 'make new vectors for every indexed passage with the configured embedding model (after changing the model)',
      run: async () => {
        const r = await reembed((done, total) => console.error(done === 0 ? `[knowledge] making new vectors for ${total} passage(s) with ${EMBEDDING_MODEL}; the documents are not read again` : `[knowledge] ${done}/${total}`));
        if (!r.ok) {
          console.log(r.why);
          process.exitCode = 1;
          return;
        }
        console.log(
          r.withVectors === r.passages
            ? `Done: ${r.withVectors} passage(s) have vectors (${r.dropped} old vector(s) dropped).`
            : `${r.withVectors} of ${r.passages} passage(s) have vectors. Another process is filling the rest, or run this again.`,
        );
      },
    },
  },
});
