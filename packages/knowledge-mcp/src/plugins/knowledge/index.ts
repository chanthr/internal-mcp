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
import { compare, measure } from './measure.js';
import { EFFORTS, type Effort } from './agent_search.js';
import { DRIVE_COLLECTION, getLocalIndex } from '../drive/qdrant.js';
import { afterFolderPass, foldersConfigured, localFolders, scanFolders, scanFoldersSoon, startFolderScans } from './folders.js';
import { startAutoOcrRun } from './ocr_run.js';
import { searchKnowledgeTool } from './tools/search_knowledge.js';
import { readDocumentTool } from './tools/read_document.js';
import { linkedDocumentsTool } from './tools/linked_documents.js';
import { findDocumentsTool } from './tools/find_documents.js';
import { saveNoteTool } from './tools/save_note.js';
import { useSkillTool } from './tools/use_skill.js';
import { cli } from '../../core/invocation.js';
import { intervalMinutes } from '../../core/env.js';
import { watchFolders } from './watch.js';
import { settingsDir } from '../../core/config.js';
import { repairWiki, wikiExists } from './wiki.js';
import { maybeRunWiki } from './wiki_auto.js';

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
  tools: [searchKnowledgeTool, readDocumentTool, linkedDocumentsTool, findDocumentsTool, saveNoteTool, useSkillTool],
  instructions:
    'Knowledge base: for any question about what the team\'s documents say, call search_knowledge first. ' +
    'Results are passages; call read_document with a Document ID when you need the whole document. ' +
    'Documents link to each other: linked_documents follows those links from a result to the pages around it. ' +
    'When it is listed, find_documents hands a question to a search assistant that searches several times and returns the documents that answer it: for a question with several parts, or one search_knowledge did not find. ' +
    'save_note keeps something as a note in this knowledge base (notes you made from documents, what you found): it is searched with the rest. ' +
    'When it is listed, use_skill lists the skills installed here (instructions for a kind of task) and reads the one a task calls for. ' +
    'Each result shows the document date: say how old a figure is rather than presenting it as current. ' +
    'Where results come from a folder named wiki, those pages were written by a model from the documents: a topic page gathers what several documents say and names them. Use it for an overview, and the documents it names for the exact wording.',
  async start({ state, log }) {
    // Pages of the wiki that a run read but did not get to write (a restart in the middle) are written now.
    try {
      if (wikiExists(settingsDir())) {
        const n = repairWiki(settingsDir());
        if (n) log(`wiki: wrote ${n} page(s) that were missing`);
      }
    } catch (e) {
      log(`wiki: could not write missing pages: ${e instanceof Error ? e.message : e}`);
    }
    // HTTP server: scan the folders now and then on a timer. KNOWLEDGE_SCAN_ENABLED=false turns it off.
    if (!(await shouldScan(state, log))) return;
    // Scans the OCR on this computer can read are read after each pass, when the person turned that on (console).
    afterFolderPass(() => void startAutoOcrRun());
    // Documents added or changed since "Keep the wiki up to date" was turned on (wiki_auto.ts).
    afterFolderPass(() => void maybeRunWiki(settingsDir(), log).catch((e) => log(`wiki: ${e instanceof Error ? e.message : e}`)));
    startFolderScans(intervalMinutes('KNOWLEDGE_SCAN_INTERVAL_MIN', 10, log), log);
    // A file saved, added or removed is read within seconds, not at the next timed pass (watch.ts).
    if (process.env.KNOWLEDGE_WATCH?.trim() !== 'false') {
      watchFolders(localFolders(), () => void scanFoldersSoon(log).catch((e) => log(`folders: scan failed: ${e instanceof Error ? e.message : e}`)), log);
    }
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
    measure: {
      description:
        'ask the measuring questions of the index as it is: where the right document comes, by keywords, by meaning and both ' +
        '(--new: write new questions; --agent[=low|medium|high]: ask the search assistant too, with the connected model)',
      run: async (args) => {
        const progress = { phase: 'asking' as const, done: 0, total: 0, way: null };
        const timer = setInterval(() => console.error(`[knowledge] ${progress.phase} ${progress.done}/${progress.total}`), 5000);
        const flag = args.find((a) => a === '--agent' || a.startsWith('--agent='));
        const agent = flag ? ((flag.split('=')[1] || 'medium') as Effort) : undefined;
        try {
          if (agent && !EFFORTS.includes(agent)) throw new Error(`--agent takes ${EFFORTS.join(', ')}.`);
          const r = await measure({ fresh: args.includes('--new'), agent, progress });
          console.log(`${r.questions} questions, ${r.passages} passages from ${r.documents} documents (${r.cut}${r.model ? `, ${r.model}` : ''})`);
          for (const k of ['both', 'keyword', 'meaning', ...(agent ? (['agent'] as const) : [])] as const) {
            const s = r.modes[k];
            console.log(
              `  ${k.padEnd(8)} ${s ? `first ${s.first}, first 3 ${s.top3}, first 10 ${s.top10}, MRR ${s.mrr}, NDCG ${s.ndcg ?? '-'}, recall ${s.recall ?? '-'}` : `not measured (${r.note})`}`,
            );
          }
          if (r.agent) console.log(`  agent: ${r.agent.model}, ${r.agent.effort}: ${r.agent.seconds} s, ${r.agent.tokens} tokens, ${r.agent.searches} searches per question`);
        } catch (e) {
          console.log(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        } finally {
          clearInterval(timer);
        }
      },
    },
    compare: {
      description: 'cut a sample of the folder documents each way, embed it in memory and ask the measuring questions by meaning; the index is not changed',
      run: async (args) => {
        const progress = { phase: 'embedding' as const, done: 0, total: 0, way: null as string | null };
        const timer = setInterval(() => console.error(`[knowledge] ${progress.phase} ${progress.way ?? ''} ${progress.done}/${progress.total}`), 5000);
        try {
          const r = await compare({ fresh: args.includes('--new'), progress });
          console.log(`${r.questions} questions on ${r.documents} documents, ${r.model}. Where the right document came, by meaning:`);
          for (const w of r.ways) console.log(`  ${w.cut.padEnd(22)} ${String(w.passages).padStart(6)} passages  first ${w.score.first}, first 3 ${w.score.top3}, first 10 ${w.score.top10}, MRR ${w.score.mrr}`);
          console.log('Set one in mcp.config.json under knowledge.index (cut, maxTokens), or choose it in the console.');
        } catch (e) {
          console.log(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        } finally {
          clearInterval(timer);
        }
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
