/**
 * Shared logic to index one Drive file into Qdrant or delete it.
 * Used by both the full reindex (reindex.ts) and the incremental sync (sync.ts).
 */
import type { DriveClient } from './client.js';
import { createHash } from 'crypto';
import { chunkMarkdown, type RawChunk } from './chunker.js';
import { cutMark, indexProfile, LEGACY_CUT, passageMark, type IndexProfile } from './index_profile.js';
import { embedTexts, embeddingsConfigured, EMBEDDING_MODEL } from './embeddings.js';
import { extractText } from './extract_text.js';
import { getQdrantClient, getLocalIndex, vectorForm, vectorProblem, vectorStoreKind, DRIVE_COLLECTION, type ChunkPayload, type VectorClient } from './qdrant.js';
import { withLock } from '../../core/lock.js';

import { DRIVE_ROOTS, MAX_FILE_BYTES, usesPathMetadata } from './settings.js';
import { normalizeFolderName } from './exclude.js';
import { getConfig } from '../../core/config.js';

export { DRIVE_ROOTS, MAX_FILE_BYTES };

/**
 * MIME types supported for extraction (must match extract_text.ts). Scanned PDFs and images go through OCR (ocr.ts).
 * Single source of truth for the full reindex and the incremental sync.
 */
export const SUPPORTED_MIMES = new Set<string>([
  'text/markdown',
  'text/plain',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);


/** Deterministic chunk ID: file_id + index always gives the same ID (idempotent upsert). Used by every indexing path. */
export function makeChunkId(fileId: string, chunkIndex: number): number {
  const hash = createHash('md5').update(`${fileId}:${chunkIndex}`).digest();
  return Number(hash.readBigUInt64BE(0) & 0x7fffffffffffffffn);
}

/** path + source -> file_type / cluster. cluster = top-level folder (generic). */
export function classifyFile(
  path: string,
  source: string,
): { type: ChunkPayload['file_type']; cluster: string | null } {
  const m = path.match(/^([^/]+)\//);
  const topFolder = m ? m[1] : null;
  return { type: usesPathMetadata(source) ? 'biz' : 'other', cluster: topFolder };
}

export interface IndexableFile {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  source: string;
  mimeType: string;
  /** Size in bytes from the Drive metadata. Google Docs files have none. */
  size?: number;
}

/**
 * Embedding input text for a chunk: the heading breadcrumb (parent > child section context) is put before the body
 * (a contextual chunk header). Parent headings are not in the chunk body (they belong to other sections), so the
 * vector loses the section context. Including them in the embedding raises recall. The content stored and displayed
 * (payload) is left as is. Only the embedding input changes. With no heading (body before the first heading) only the
 * body is used. The legacy placeholder heading checked below is skipped too. Single source of truth for the
 * incremental (indexFile) and full (reindex.ts) paths: both must embed the same input so the same chunk gets the
 * same vector (consistent vector space).
 */
export function embedInputForChunk(chunk: Pick<RawChunk, 'heading' | 'content'>, documentName?: string, profile: Pick<IndexProfile, 'header' | 'passagePrefix'> = indexProfile()): string {
  const heading = chunk.heading?.trim();
  const h = !heading || heading === '문서 시작' ? '' : heading;
  // Which of these the model is given is a setting (index_profile.ts): the heading path, the document's name
  // before it, or the passage alone. A prefix the model was trained with goes before everything.
  const name = profile.header === 'document' ? (documentName ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() : '';
  const head = profile.header === 'none' ? '' : [name, h].filter(Boolean).join(' > ');
  return `${profile.passagePrefix}${head ? `${head}\n\n` : ''}${chunk.content}`;
}

/** Extracted text to sha256 (used to skip reindexing unchanged content). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface BizMeta {
  doc_category: string | null;
  doc_customer: string | null;
  path_tags: string[];
}

// Strips a numeric prefix ("01_", "06_", "0316_") from folder and file names.
const NN_PREFIX = /^\d{1,4}[_-]/;
// Names of top-level folders that hold one subfolder per customer (config drive.customerFolders). Compared with the
// numeric prefix removed and case ignored.
const CUSTOMER_FOLDERS = getConfig().drive.customerFolders.map((n) => normalizeFolderName(n.replace(NN_PREFIX, '')));

/**
 * Derives metadata from the path and file name for biz sources (PDF/docx, no front matter).
 * EXTRACTED: facts a person set by filing into folders (not LLM inference). For dev sources the front matter is the
 * source of truth, so these are empty.
 *   doc_category : top-level folder (NN_ removed)  e.g. "01_Clients/…" → "Clients"
 *   doc_customer : {customerFolders}/{name}  e.g. "01_Clients/Acme/…" → "Acme"
 *   path_tags    : folder segments (NN_ removed) + file name tokens (search tags)
 */
export function deriveBizMeta(path: string, source: string): BizMeta {
  if (!usesPathMetadata(source)) return { doc_category: null, doc_customer: null, path_tags: [] };
  const segs = path.split('/').filter(Boolean);
  const folders = segs.slice(0, -1); // the last one is the file name
  const fileName = segs[segs.length - 1] ?? '';
  const strip = (s: string) => s.replace(NN_PREFIX, '');
  const category = folders[0] ? strip(folders[0]) : null;
  const top = folders[0] ? normalizeFolderName(strip(folders[0])) : '';
  const customer = top && folders[1] && CUSTOMER_FOLDERS.some((c) => c && top.includes(c)) ? folders[1] : null;
  const folderTags = folders.map(strip);
  const nameTokens = fileName
    .replace(/\.[a-z0-9]+$/i, '') // drop the extension
    .split(/[_\-\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const path_tags = [...new Set([...folderTags, ...nameTokens])].filter(Boolean);
  return { doc_category: category, doc_customer: customer, path_tags };
}

/**
 * chunk + file/classification/path metadata to ChunkPayload. Shared by the full reindex (reindex.ts) and the
 * incremental path (indexFile).
 * Dev metadata arrives in chunk (parsed front matter), biz metadata in bizMeta (parsed path).
 */
export function buildChunkPayload(
  chunk: RawChunk,
  file: IndexableFile,
  idx: number,
  chunkCount: number,
  classification: { type: ChunkPayload['file_type']; cluster: string | null },
  bizMeta: BizMeta,
  hash: string,
): ChunkPayload {
  const tags = [...new Set([...chunk.doc_tags, ...bizMeta.path_tags])];
  return {
    chunk_id: `${file.id}_${idx}`,
    file_id: file.id,
    file_name: file.name,
    file_path: file.path,
    heading: chunk.heading,
    chunk_index: idx,
    chunk_count: chunkCount,
    content: chunk.content,
    modified_time: file.modifiedTime,
    content_hash: hash,
    cut: cutMark(),
    file_type: classification.type,
    cluster: classification.cluster,
    source: file.source,
    image_urls: chunk.image_urls,
    has_image: chunk.image_urls.length > 0,
    table_count: chunk.table_count,
    has_code_block: chunk.has_code_block,
    doc_status: chunk.doc_status,
    doc_date: chunk.doc_date,
    doc_authors: chunk.doc_authors,
    doc_related: chunk.doc_related,
    doc_source_refs: chunk.doc_source_refs,
    doc_affects: chunk.doc_affects,
    doc_products: chunk.doc_products,
    doc_type: chunk.doc_type,
    doc_confidence: chunk.doc_confidence,
    doc_tags: tags,
    doc_category: bizMeta.doc_category,
    doc_customer: bizMeta.doc_customer,
  };
}

/**
 * Looks up the indexed state of a file (payload of chunk 0): content_hash and chunk count.
 * Returns null if not found (not indexed). A failed lookup is also treated as null (safe: reindexing proceeds).
 */
export async function getIndexedState(
  fileId: string,
): Promise<{
  content_hash: string | null;
  chunk_count: number;
  file_path: string;
  file_name: string;
  source: string;
  modified_time: string;
  /** How it was cut (index_profile.ts cutMark). A document indexed before this was kept was cut the default way. */
  cut: string;
} | null> {
  try {
    const got = await (await getQdrantClient()).retrieve(DRIVE_COLLECTION, {
      ids: [makeChunkId(fileId, 0)],
      with_payload: true,
      with_vector: false,
    });
    if (!got || got.length === 0) return null;
    const p = got[0].payload as Record<string, unknown> | undefined;
    return {
      content_hash: (p?.content_hash as string) ?? null,
      chunk_count: typeof p?.chunk_count === 'number' ? (p.chunk_count as number) : 0,
      file_path: String(p?.file_path ?? ''),
      file_name: String(p?.file_name ?? ''),
      source: String(p?.source ?? ''),
      modified_time: String(p?.modified_time ?? ''),
      cut: typeof p?.cut === 'string' ? p.cut : LEGACY_CUT,
    };
  } catch {
    return null; // lookup failed = unknown, so reindex (safe)
  }
}

/**
 * Extracts one file by format, then chunk → embed → Qdrant upsert. Returns the number of chunks indexed (0 on skip).
 *
 * - If the sha256 of the extracted text equals the indexed one, embed and upsert are skipped (unchanged).
 * - If a reindex produces fewer chunks, the old ones (chunk_index >= new count) are deleted so no ghost chunks
 *   (retired facts) remain.
 * - The incremental path uses wait:true, so the file is searchable right after indexing and failures are noticed.
 */
export async function indexFile(drive: DriveClient, file: IndexableFile): Promise<number> {
  if (file.size && file.size > MAX_FILE_BYTES) {
    console.error(`[index] skip (too large: ${file.size}B > ${MAX_FILE_BYTES}B): ${file.path}`);
    return 0;
  }
  // If the modified time, path, name and source are all unchanged, the file is not even downloaded. This stops
  // re-downloading the whole file (up to 50MB) and re-running paid OCR for a change to sharing settings or a star only.
  const prev = await getIndexedState(file.id);
  const sameLocation = !!prev && prev.file_path === file.path && prev.file_name === file.name && prev.source === file.source;
  // (Cut another way than the settings ask for now, it is read and cut again.)
  if (sameLocation && prev!.modified_time && prev!.modified_time === file.modifiedTime && prev!.cut === cutMark()) return 0;

  const { text, needsOcr } = await extractText(drive, file.id, file.mimeType);
  // Unsupported files, scans and images with OCR off, and files with empty extracted text are not indexed.
  if (needsOcr || text.trim().length === 0) return 0;
  return indexText(file, text, prev);
}

/**
 * Index the extracted text of one document: chunk, embed when an embedding model is configured, and store.
 * Shared by every source (Drive files, local folders). `prev` is the document's indexed state when the caller
 * already looked it up; otherwise it is read here.
 *
 * Without an embedding model the chunks are stored for keyword search only. Their vectors are added later by
 * backfillVectors once a model is configured, without reading the document again.
 */
export async function indexText(
  file: IndexableFile,
  text: string,
  prev: Awaited<ReturnType<typeof getIndexedState>> | undefined = undefined,
  /** `vectors: false` stores the text now and leaves the vectors to backfillVectors (see folders.ts). */
  opts: { vectors?: boolean } = {},
): Promise<number> {
  if (prev === undefined) prev = await getIndexedState(file.id);
  const sameLocation = !!prev && prev.file_path === file.path && prev.file_name === file.name && prev.source === file.source;
  const hash = contentHash(text);

  // If the body, path and name are all unchanged, skip embed and upsert (e.g. a save that only changed the modified
  // time). A file that was moved or only renamed is indexed again: the payload file_path decides the per-user folder
  // scope, so a stale path would keep the file searchable by people with access to the old folder after the move.
  // Path tags (doc_tags) are also rebuilt for every chunk.
  if (sameLocation && prev!.content_hash === hash && prev!.cut === cutMark()) return 0;

  const chunks = chunkMarkdown(text);
  if (chunks.length === 0) return 0;

  const classification = classifyFile(file.path, file.source);
  const bizMeta = deriveBizMeta(file.path, file.source);
  // Embed with the heading breadcrumb (embedInputForChunk): the stored content is unchanged, only the embedding input
  // gets the section context. No embedding model: store the text now, vectors come later (backfillVectors).
  // In the form the vectors already in the index were made in (qdrant.ts vectorForm): the two are not mixed.
  const form = opts.vectors !== false && (await vectorsUsable()) ? await vectorForm() : null;

  const client = await getQdrantClient();
  if (form) await noteVectorModel(form);
  // Upsert the new chunks 0..M-1 (wait:true: cheap for one file, gives immediate search visibility and failure detection)
  await storeChunks(
    client,
    chunks,
    (c, idx) => ({ id: makeChunkId(file.id, idx), payload: buildChunkPayload(c, file, idx, chunks.length, classification, bizMeta, hash) }),
    form ? (c) => embedInputForChunk(c, file.name, form) : null,
    true,
  );
  // If the count shrank, delete the old chunks (index >= M) directly by their deterministic chunk IDs.
  // (A Qdrant range filter returns 400 Bad Request on a non-indexed payload, so delete by ID instead. The set is
  // disjoint from the upserted one.)
  if (prev && prev.chunk_count > chunks.length) {
    const orphanIds: number[] = [];
    for (let i = chunks.length; i < prev.chunk_count; i++) orphanIds.push(makeChunkId(file.id, i));
    await client.delete(DRIVE_COLLECTION, { wait: true, points: orphanIds });
  }
  return chunks.length;
}

/** Chunks embedded and stored per round: the vectors of one round are all that is held at a time. */
const STORE_BATCH = 128;

/**
 * Store one document's chunks, embedding them when `embedInput` is given, a round of STORE_BATCH at a time. Embedding
 * a whole document before storing any of it held every vector at once: 7,600 for a 5-million-character document, a
 * hundred megabytes, and more than a gigabyte for a file at the size limit.
 *
 * The round with chunk 0 goes last. Chunk 0 carries the content hash that says the document is indexed, so a run
 * that fails half way leaves the document to be indexed again instead of looking done. In the built-in index a
 * passage the endpoint refuses (too long for the model, say) is stored for keyword search and set aside without a
 * vector (embedEach); Qdrant holds nothing without a vector, so there the document fails as before.
 */
export async function storeChunks(
  client: VectorClient,
  chunks: RawChunk[],
  pointOf: (chunk: RawChunk, idx: number) => { id: number; payload: ChunkPayload },
  embedInput: ((chunk: RawChunk) => string) | null,
  wait: boolean,
): Promise<void> {
  const local = await getLocalIndex();
  const starts: number[] = [];
  for (let start = STORE_BATCH; start < chunks.length; start += STORE_BATCH) starts.push(start);
  starts.push(0);
  for (const start of starts) {
    const part = chunks.slice(start, start + STORE_BATCH);
    const vectors = embedInput ? await (local ? embedEach : embedTexts)(part.map(embedInput)) : null;
    const points = part.map((c, i) => {
      const v = vectors?.[i];
      return { ...pointOf(c, start + i), vector: Array.isArray(v) ? v : undefined };
    });
    await client.upsert(DRIVE_COLLECTION, { wait, points });
    const refused = points.flatMap((p, i) => (vectors && !Array.isArray(vectors[i]) ? [{ id: p.id, reason: (vectors[i] as Refused).refused }] : []));
    if (local && refused.length) await setAside(local, refused);
  }
}

/** A passage the embedding endpoint refused, and what it said. */
export interface Refused {
  refused: string;
}

/**
 * Statuses with which an embedding endpoint refuses what it was sent rather than failing: llama.cpp and LM Studio
 * answer 400 "input is too large to process" for a passage longer than the model takes.
 */
function refusedInput(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 400 || status === 413 || status === 422;
}

/**
 * Embed passages, finding the ones the endpoint refuses instead of failing them all: a vector for each input, or why
 * it was refused. When a batch is refused, one short probe tells a refused passage from an endpoint that refuses
 * everything (no model loaded, a wrong model name); only when the probe passes is the batch halved until the refused
 * passages are found. Otherwise the error is thrown, as embedTexts would.
 */
export async function embedEach(inputs: string[]): Promise<Array<number[] | Refused>> {
  try {
    return await embedTexts(inputs);
  } catch (e) {
    if (!refusedInput(e)) throw e;
    try {
      await embedTexts(['probe']);
    } catch {
      throw e;
    }
    return isolateRefused(inputs, e);
  }
}

/** `inputs` were refused together: halve them until each refused passage stands alone. */
async function isolateRefused(inputs: string[], why: unknown): Promise<Array<number[] | Refused>> {
  if (inputs.length === 1) return [{ refused: why instanceof Error ? why.message : String(why) }];
  const out: Array<number[] | Refused> = [];
  const half = Math.ceil(inputs.length / 2);
  for (const part of [inputs.slice(0, half), inputs.slice(half)]) {
    try {
      out.push(...(await embedTexts(part)));
    } catch (e) {
      if (!refusedInput(e)) throw e;
      out.push(...(await isolateRefused(part, e)));
    }
  }
  return out;
}

/** Passages the endpoint refused: kept for keyword search, and no longer offered for a vector (missingVectors). */
async function setAside(index: NonNullable<Awaited<ReturnType<typeof getLocalIndex>>>, refused: Array<{ id: number; reason: string }>): Promise<void> {
  await index.refuseVectors(DRIVE_COLLECTION, refused);
  console.error(`[index] the embedding endpoint refused ${refused.length} passage(s); they are found by keywords only: ${refused[0].reason.slice(0, 200)}`);
}

/** Deletes every chunk of a file from Qdrant (when the file is deleted or trashed). */
export async function deleteFileVectors(fileId: string): Promise<void> {
  await (await getQdrantClient()).delete(DRIVE_COLLECTION, {
    filter: { must: [{ key: 'file_id', match: { value: fileId } }] },
  });
}

/**
 * Can documents be indexed at all? The built-in index stores text without vectors, so it always can.
 * Qdrant stores vectors only, so it needs an embedding model.
 */
export function indexAvailable(): boolean {
  return vectorStoreKind() === 'built-in' || embeddingsConfigured();
}

/** The lock that keeps two runs from embedding the same passages twice (and paying twice). */
export const BACKFILL_LOCK = 'backfill';

/**
 * Give vectors to up to `max` chunks that have none, from the stored chunk text. For a caller that already holds
 * BACKFILL_LOCK. Returns how many chunks were dealt with (`handled`: given a vector, or set aside because the
 * endpoint refused them) and how many got a vector (`made`). A refused chunk is set aside so that the next batch is
 * not the same one again: one refused passage at the head of the queue used to keep every other from a vector.
 */
export async function fillMissingVectors(max: number): Promise<{ handled: number; made: number }> {
  const index = await getLocalIndex();
  if (!index) return { handled: 0, made: 0 };
  let handled = 0;
  let made = 0;
  while (handled < max) {
    const batch = await index.missingVectors(DRIVE_COLLECTION, Math.min(STORE_BATCH, max - handled));
    if (batch.length === 0) break;
    const form = await vectorForm();
    const inputs = batch.map((b) =>
      embedInputForChunk({ heading: String(b.payload?.heading ?? ''), content: String(b.payload?.content ?? '') }, String(b.payload?.file_name ?? ''), form),
    );
    const vectors = await embedEach(inputs);
    const good = batch.flatMap((b, i) => (Array.isArray(vectors[i]) ? [{ id: b.id, vector: vectors[i] as number[] }] : []));
    if (good.length) {
      await index.setVectors(DRIVE_COLLECTION, good);
      await index.noteModel(DRIVE_COLLECTION, EMBEDDING_MODEL, passageMark(form));
    }
    const refused = batch.flatMap((b, i) => (Array.isArray(vectors[i]) ? [] : [{ id: b.id, reason: (vectors[i] as Refused).refused }]));
    if (refused.length) await setAside(index, refused);
    handled += batch.length;
    made += good.length;
  }
  return { handled, made };
}

/**
 * Give vectors to chunks that were indexed before an embedding model was configured (built-in index only).
 * Uses the stored chunk text, so no document is downloaded or extracted again. Works in rounds of `round` chunks
 * and lets go of the lock between rounds, until none is left: a large index is finished in one go instead of a
 * round per sync. Returns how many chunks got a vector (0 when another run is at it).
 */
export async function backfillVectors(round = 20_000): Promise<number> {
  if (!(await getLocalIndex()) || !(await vectorsUsable())) return 0;
  let total = 0;
  try {
    for (;;) {
      const done = await withLock(BACKFILL_LOCK, () => fillMissingVectors(round));
      if (!done?.handled) break; // nothing left, or another run holds the lock
      total += done.made;
      status.filled += done.made;
      status.filledAt = new Date().toISOString();
      // A round that made vectors means the model answers again: the last failure is no longer the news.
      status.error = null;
      status.errorAt = null;
    }
  } catch (e) {
    // The endpoint is down or too slow: said on the console, and tried again soon rather than at the next pass.
    status.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    status.errorAt = new Date().toISOString();
    retrySoon();
    throw e;
  }
  status.error = null;
  status.errorAt = null;
  retryStep = 0;
  return total;
}

// ── Making vectors: how it went, and trying again after a failure ──

const status = { error: null as string | null, errorAt: null as string | null, filled: 0, filledAt: null as string | null, retryAt: null as string | null };
/** How making vectors went since the server started: the last failure (until a round succeeds) and what was made. */
export const vectorStatus = (): Readonly<typeof status> => ({ ...status });

/** Pauses before vectors that failed are tried again: a minute, then five, then a quarter of an hour. */
const RETRY_STEPS = (process.env.EMBED_RETRY_STEPS_MS ?? '60000,300000,900000').split(',').map(Number);
let retryStep = 0;
let retryTimer: NodeJS.Timeout | null = null;
function retrySoon(): void {
  if (retryTimer) return;
  const ms = RETRY_STEPS[Math.min(retryStep++, RETRY_STEPS.length - 1)];
  status.retryAt = new Date(Date.now() + ms).toISOString();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    status.retryAt = null;
    void backfillVectors().catch(() => undefined);
  }, ms);
  retryTimer.unref?.();
}

/**
 * Can vectors be written and searched right now? An embedding model is configured, and the vectors already stored
 * (if any) were made by it. When false, indexing stores text only and search answers by keywords.
 */
export async function vectorsUsable(): Promise<boolean> {
  return embeddingsConfigured() && (await vectorProblem()) === null;
}

/** Record which model made the vectors (built-in index), so a later change of model is noticed. */
export async function noteVectorModel(form: Pick<IndexProfile, 'header' | 'passagePrefix'>): Promise<void> {
  await (await getLocalIndex())?.noteModel(DRIVE_COLLECTION, EMBEDDING_MODEL, passageMark(form));
}
