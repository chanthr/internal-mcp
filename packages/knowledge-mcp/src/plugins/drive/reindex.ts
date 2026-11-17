/**
 * Full Drive indexing script.
 *
 * What it does:
 *   1. List every .md file in Drive (recursive, folder by folder)
 *   2. Download each file to get the markdown body
 *   3. Chunk by heading and count tokens
 *   4. OpenAI embedding (batch)
 *   5. Qdrant upsert (idempotent, keyed by chunk_id)
 *
 * Usage (drive plugin commands):
 *   knowledge-mcp drive reindex                     # index all configured Drive roots
 *   knowledge-mcp drive reindex --root <folderId>   # one folder only
 *   knowledge-mcp drive reindex --dry-run           # no indexing, statistics only
 *   knowledge-mcp drive reindex --recreate          # empty the collection and start over
 *
 * A run over all roots (no --root/--source) ends by deleting the vectors of files that are not in this run's listing.
 * This cleans up chunks of files moved into an excluded folder, of folders added to excludeFolders later, and of
 * roots removed from the config.
 */
import type { DriveClient } from './client.js';
import { getDriveClient } from './client.js';
import { chunkMarkdown } from './chunker.js';
import { embedTexts, embeddingsConfigured, EMBEDDING_MODEL } from './embeddings.js';
import { extractText } from './extract_text.js';
import { isExcludedName } from './exclude.js';
import { classifyAndPath, ownerEmails } from './path.js';
import { sharedScopeEnabled, SHARED_SOURCE } from './settings.js';
import { ensureCollection, getQdrantClient, isDriveDocId, vectorProblem, DRIVE_COLLECTION } from './qdrant.js';
// Single source of truth for the core indexing logic, shared with the incremental sync (sync.ts) to prevent drift.
// In particular makeChunkId must match on both paths for the orphan chunk logic to hold.
import {
  makeChunkId,
  classifyFile,
  contentHash,
  buildChunkPayload,
  deriveBizMeta,
  embedInputForChunk,
  SUPPORTED_MIMES,
  DRIVE_ROOTS,
  MAX_FILE_BYTES,
  noteVectorModel,
  vectorsUsable,
} from './indexer.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { dataDir } from '../../core/paths.js';
import { createLimiter } from '../../core/concurrency.js';

// Cap on concurrent folder listing calls. Opening subfolders with no limit hits the Drive rate limit (403) when there
// are thousands of folders.
const listGate = createLimiter(Number(process.env.DRIVE_LIST_CONCURRENCY ?? 8));

// Checkpoint: records finished files so a restart skips them (resume after a 429 abort, cheaper reruns).
// It stores modifiedTime per file and the collection name for the whole run. So a file changed in the meantime, or a
// run against another collection (a reindex after switching QDRANT_COLLECTION), does not trust the checkpoint. The old
// format (an array of file_id) is discarded and the run starts from scratch.
// It is kept in the data folder (the package folder is an npm install and may not be writable).
const CHECKPOINT_PATH = join(dataDir(), 'drive-reindex-checkpoint.json');
type Checkpoint = Map<string, string>; // file_id → modifiedTime
function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_PATH)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')) as { collection?: string; files?: Record<string, string> };
    if (raw.collection !== DRIVE_COLLECTION || !raw.files) return new Map();
    return new Map(Object.entries(raw.files));
  } catch {
    return new Map();
  }
}
function saveCheckpoint(done: Checkpoint): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({ collection: DRIVE_COLLECTION, files: Object.fromEntries(done) }));
}
function clearCheckpoint(): void {
  if (existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
}

interface DriveRoot {
  id: string;
  name: string;
  source: string;
}

interface CliArgs {
  roots: DriveRoot[];
  dryRun: boolean;
  /** Leave out files that need OCR instead of sending them to Mathpix (billed per page). */
  noOcr: boolean;
  recreate: boolean;
  /** True when the run covers only some roots. Cleanup is then skipped so vectors of other roots are not deleted. */
  partial: boolean;
}

function parseArgs(args: string[]): CliArgs {
  let roots: DriveRoot[] = DRIVE_ROOTS;
  if (DRIVE_ROOTS.length === 0 && !sharedScopeEnabled()) {
    // A full run with an empty list would make the "files not in the listing" cleanup delete the whole collection.
    throw new Error(
      'drive.roots is empty and drive.scope is "roots", so there is nothing to index. Set drive.roots in mcp.config.json or MCP_CONFIG_JSON ' +
        '(the Docker image reads /app/mcp.config.json).',
    );
  }
  let dryRun = false;
  let noOcr = false;
  let recreate = false;
  let partial = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      // Only a configured root is accepted. An arbitrary folder would be indexed with short paths relative to that
      // folder, which bypasses folder permissions, or would bring content outside the roots into the search index.
      const id = args[++i];
      const root = DRIVE_ROOTS.find((r) => r.id === id);
      if (!root) throw new Error(`--root ${id} is not one of drive.roots (${DRIVE_ROOTS.map((r) => r.id).join(', ')})`);
      roots = [root];
      partial = true;
    } else if (args[i] === '--source' && args[i + 1]) {
      const label = args[++i];
      roots = DRIVE_ROOTS.filter((r) => r.source === label);
      if (roots.length === 0) throw new Error(`--source ${label} matches no root (labels: ${[...new Set(DRIVE_ROOTS.map((r) => r.source))].join(', ')})`);
      partial = true;
    } else if (args[i] === '--biz-only' || args[i] === '--dev-only') {
      // 0.3 names for --source biz / --source dev.
      const label = args[i] === '--biz-only' ? 'biz' : 'dev';
      roots = DRIVE_ROOTS.filter((r) => r.source === label);
      partial = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--no-ocr') {
      noOcr = true;
    } else if (args[i] === '--recreate') {
      // Empty the collection and rebuild (removes orphan chunks, reflects changes in cleaning and chunk counts)
      recreate = true;
    }
  }
  return { roots, dryRun, noOcr, recreate, partial };
}

interface ListedFile {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  mimeType: string;
  size?: number;
}

/**
 * Recursively lists files of supported types under a folder ID (deprecated excluded).
 */
async function listAllMarkdown(
  drive: DriveClient,
  folderId: string,
  pathPrefix: string,
): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const subfolderTasks: Promise<ListedFile[]>[] = []; // subfolder recursion runs in parallel
  let pageToken: string | undefined;

  do {
    const resp = await listGate(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
        pageSize: 100,
        pageToken,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
    );

    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name) continue;
      const currentPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // Skip excluded folders (sensitive PII/contracts/HR and development artifacts, see exclude.ts): no recursion
        if (isExcludedName(f.name)) continue;
        // gather as parallel tasks instead of sequential await (hundreds of folders: minutes -> seconds)
        subfolderTasks.push(listAllMarkdown(drive, f.id, currentPath));
      } else if (f.mimeType && SUPPORTED_MIMES.has(f.mimeType)) {
        out.push({
          id: f.id,
          name: f.name,
          path: currentPath,
          modifiedTime: f.modifiedTime ?? '',
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
        });
      }
    }

    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Merge the results of the parallel subfolder recursion
  const childResults = await Promise.all(subfolderTasks);
  for (const child of childResults) out.push(...child);

  return out;
}

/**
 * Files shared with the service account that are not under any root. `sharedWithMe` returns only the top item of each
 * share (a shared folder is one entry), so folders are walked. Items under a root are left to the root listing, and
 * excluded folders are skipped. Paths start at the top shared folder.
 */
async function listSharedOutsideRoots(drive: DriveClient): Promise<ListedFile[]> {
  const rootIds = new Set(DRIVE_ROOTS.map((r) => r.id));
  const out: ListedFile[] = [];
  const untrusted: string[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await drive.files.list({
      q: 'sharedWithMe = true and trashed = false',
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, owners(emailAddress), driveId)',
      pageSize: 200,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name || rootIds.has(f.id)) continue;
      const { cls, path: parentPath } = await classifyAndPath(drive, f.parents ?? undefined, { owners: ownerEmails(f), driveId: f.driveId });
      if (cls !== 'shared') {
        // Not under a root, and either excluded or shared by someone who is not in drive.trustedOwners.
        if (!rootIds.has(f.id) && (f.parents ?? []).length === 0 && !isExcludedName(f.name)) untrusted.push(`${f.name} (${ownerEmails(f).join(', ') || 'shared drive'})`);
        continue;
      }
      if (isExcludedName(f.name)) continue;
      const path = parentPath ? `${parentPath}/${f.name}` : f.name;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        out.push(...(await listAllMarkdown(drive, f.id, path)));
      } else if (f.mimeType && SUPPORTED_MIMES.has(f.mimeType)) {
        out.push({ id: f.id, name: f.name, path, modifiedTime: f.modifiedTime ?? '', mimeType: f.mimeType, size: f.size ? Number(f.size) : undefined });
      }
    }
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);
  if (untrusted.length) {
    console.log(`[index] ${untrusted.length} shared item(s) left out, owner not in drive.trustedOwners: ${untrusted.slice(0, 5).join('; ')}${untrusted.length > 5 ? ' …' : ''}`);
    console.log('[index] to include them: knowledge-mcp setup trust <email-or-domain>');
  }
  return out;
}

/**
 * Deletes the Drive documents that are not in this run's listing (keep). Returns the number of files deleted.
 * If the listing step fails, main exits with FATAL before this point, so reaching here means the listing is complete.
 */
export async function pruneStaleVectors(keep: Set<string>): Promise<number> {
  const qdrant = await getQdrantClient();
  const stale = new Set<string>();
  let offset: string | number | null | undefined = undefined;
  do {
    const page = await qdrant.scroll(DRIVE_COLLECTION, {
      limit: 1000,
      offset: offset ?? undefined,
      with_payload: ['file_id'],
      with_vector: false,
    });
    for (const pt of page.points) {
      const fid = (pt.payload as { file_id?: unknown } | null | undefined)?.file_id;
      // Only Drive documents: documents from other sources (local folders) are not in a Drive listing by nature.
      if (typeof fid === 'string' && isDriveDocId(fid) && !keep.has(fid)) stale.add(fid);
    }
    offset = (page.next_page_offset as string | number | null | undefined) ?? null;
  } while (offset !== null);
  for (const fid of stale) {
    await qdrant.delete(DRIVE_COLLECTION, {
      wait: true,
      filter: { must: [{ key: 'file_id', match: { value: fid } }] },
    });
  }
  return stale.size;
}

/** `knowledge-mcp drive reindex [--root ID | --source LABEL] [--dry-run] [--recreate] [--no-ocr]` */
export async function runReindex(argv: string[]): Promise<void> {
  const { roots, dryRun, noOcr, recreate, partial } = parseArgs(argv);
  let ocrLeftOut = 0;
  const startTs = Date.now();

  console.log(
    `[index] start — roots=${roots.map((r) => r.name).join(',')} dryRun=${dryRun} recreate=${recreate}`,
  );

  // 1. Ensure the Qdrant collection exists (with --recreate, drop the existing one and create it again)
  if (!dryRun) {
    if (recreate) {
      try {
        await (await getQdrantClient()).deleteCollection(DRIVE_COLLECTION);
        console.log(`[index] collection '${DRIVE_COLLECTION}' deleted (recreate)`);
      } catch {
        /* ignore if it does not exist */
      }
    }
    await ensureCollection();
    console.log(`[index] collection '${DRIVE_COLLECTION}' ready`);
  }

  // 2. List all markdown in Drive (per root)
  const drive = await getDriveClient();
  const allFiles: Array<ListedFile & { source: string }> = [];

  for (const root of roots) {
    const files = await listAllMarkdown(drive, root.id, '');
    console.log(`[index] '${root.name}' (${root.source}) — ${files.length} files`);
    for (const f of files) allFiles.push({ ...f, source: root.source });
  }
  // Documents shared with the service account outside the roots (drive.scope "shared"). Skipped on a partial run.
  if (!partial && sharedScopeEnabled()) {
    const seen = new Set(allFiles.map((f) => f.id));
    const shared = (await listSharedOutsideRoots(drive)).filter((f) => !seen.has(f.id) && !!seen.add(f.id));
    console.log(`[index] shared outside the roots (${SHARED_SOURCE}) — ${shared.length} files`);
    for (const f of shared) allFiles.push({ ...f, source: SHARED_SOURCE });
  }
  console.log(`[index] total ${allFiles.length} files`);
  // Vectors are written only when a model is configured and the stored vectors (if any) are that model's.
  const useVectors = await vectorsUsable();
  if (embeddingsConfigured() && !useVectors) console.error(`[index] storing text only: ${await vectorProblem()}`);

  // 3. Per file: download + chunk + embed + upsert
  //    Checkpoint: reset on recreate, otherwise skip earlier progress (resume after a 429 abort)
  if (recreate) clearCheckpoint();
  const done: Checkpoint = dryRun ? new Map() : loadCheckpoint();
  if (done.size > 0) console.log(`[index] checkpoint — skipping ${done.size} already processed files`);

  let totalChunks = 0;
  let totalTokens = 0;
  let processed = 0;

  for (const file of allFiles) {
    processed++;
    if (done.get(file.id) === file.modifiedTime) continue; // checkpoint: already processed (and unchanged since)
    if (file.size && file.size > MAX_FILE_BYTES) {
      console.log(`[index] skip (too large: ${file.size}B > ${MAX_FILE_BYTES}B): [${file.source}] ${file.path}`);
      done.set(file.id, file.modifiedTime);
      if (!dryRun) saveCheckpoint(done);
      continue;
    }
    try {
      // A dry run does not call OCR (Mathpix charges per page).
      const { text, needsOcr } = await extractText(drive, file.id, file.mimeType, { ocr: !dryRun && !noOcr });
      if (needsOcr && noOcr) {
        // Not recorded as done: a later run with OCR must still pick this file up.
        ocrLeftOut++;
        continue;
      }
      if (needsOcr || text.trim().length === 0) {
        console.log(`[index] skip (ocr/empty): [${file.source}] ${file.path}`);
        done.set(file.id, file.modifiedTime);
        if (!dryRun) saveCheckpoint(done);
        continue;
      }
      const chunks = chunkMarkdown(text);
      if (chunks.length === 0) {
        console.log(`[index] skip empty: [${file.source}] ${file.path}`);
        // Record as done. Otherwise the checkpoint stays forever and the next reindex skips changed files.
        done.set(file.id, file.modifiedTime);
        if (!dryRun) saveCheckpoint(done);
        continue;
      }

      const classification = classifyFile(file.path, file.source);
      const bizMeta = deriveBizMeta(file.path, file.source);
      const hash = contentHash(text); // used to skip unchanged files, stored in the payload (defined in indexer.ts)
      const fileTokens = chunks.reduce((s, c) => s + c.tokens, 0);
      totalChunks += chunks.length;
      totalTokens += fileTokens;

      if (dryRun) {
        console.log(
          `[index] [${processed}/${allFiles.length}] [${file.source}] ${file.path} — ${chunks.length} chunks, ${fileTokens} tok`,
        );
        continue;
      }

      // Embed with the heading breadcrumb (embedInputForChunk), the same input as the incremental path (indexFile).
      // No embedding model: the text is stored for keyword search and vectors are added later (backfillVectors).
      const vectors = useVectors ? await embedTexts(chunks.map(embedInputForChunk)) : null;

      // Qdrant upsert: the payload is built by buildChunkPayload, shared with indexer.ts
      const points = chunks.map((c, idx) => ({
        id: makeChunkId(file.id, idx),
        vector: vectors?.[idx],
        payload: buildChunkPayload(c, file, idx, chunks.length, classification, bizMeta, hash),
      }));

      const qdrant = await getQdrantClient();
      // Delete all existing chunks of this file, then upsert the new ones (no ghost chunks left when the count shrinks).
      // Only the verified match filter is used (a range filter returns 400 on a non-indexed payload). With --recreate
      // it matches nothing (no-op). A full reindex is a batch job, so the short gap between delete and upsert is fine.
      await qdrant.delete(DRIVE_COLLECTION, {
        wait: false,
        filter: { must: [{ key: 'file_id', match: { value: file.id } }] },
      });
      await qdrant.upsert(DRIVE_COLLECTION, {
        wait: false,
        points,
      });
      if (vectors) await noteVectorModel();

      done.set(file.id, file.modifiedTime); // record in the checkpoint (upsert succeeded)
      saveCheckpoint(done);

      console.log(
        `[index] [${processed}/${allFiles.length}] [${file.source}] ${file.path} — ${chunks.length} chunks upserted (${fileTokens} tok)`,
      );
    } catch (err) {
      // Failed files are not recorded in the checkpoint, so a rerun retries them
      console.error(
        `[index] ERROR [${file.source}] ${file.path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. Clean up vectors of files not in this run's listing (only for a run over all roots)
  if (!dryRun && !partial) {
    if (allFiles.length === 0) {
      // An empty listing (permission problem, wrong root id) would make cleanup delete the whole collection. Skip it.
      console.error('[index] listed 0 files — skipping cleanup so the existing index is not wiped. Check drive.roots and sharing.');
    } else {
      const pruned = await pruneStaleVectors(new Set(allFiles.map((f) => f.id)));
      console.log(`[index] cleanup — deleted vectors of ${pruned} files no longer listed`);
    }
  }

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  // Cost is only known for the default model (OpenAI text-embedding-3-small: $0.02 per 1M tokens).
  const cost = EMBEDDING_MODEL === 'text-embedding-3-small' ? `, ~$${((totalTokens / 1_000_000) * 0.02).toFixed(4)}` : '';
  console.log(
    `\n[index] DONE — ${totalChunks} chunks, ${totalTokens} tokens, ` +
      `${useVectors ? `model ${EMBEDDING_MODEL}${cost}` : embeddingsConfigured() ? 'keyword index only (stored vectors are from another model)' : 'keyword index only (no embedding model)'}, ${elapsedSec}s`,
  );
  if (ocrLeftOut > 0) {
    console.log(`[index] ${ocrLeftOut} scanned file(s) or image(s) were left out because they need OCR. To include them: knowledge-mcp drive reindex (Mathpix is billed per page).`);
  }
  // If everything succeeded, clear the checkpoint (keep it if failures remain)
  if (!dryRun && done.size + ocrLeftOut >= allFiles.length) clearCheckpoint();
}

