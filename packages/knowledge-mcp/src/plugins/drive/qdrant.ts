/**
 * Qdrant REST client and collection management.
 *
 * Collection: config.qdrant.collection (default knowledge_v1), or env QDRANT_COLLECTION.
 * Vector size: 1536 (text-embedding-3-small)
 * Distance: Cosine
 *
 * Calls the REST API with Node's built-in fetch instead of @qdrant/js-client-rest. Even the latest release (1.19) of
 * that library pins a vulnerable undici 7.29 as a dependency, which left an npm audit warning for everyone who installs
 * this package. Only nine endpoints are used, so calling them directly is lighter. Method names and return shapes
 * are kept the same as that library.
 */
import { EMBEDDING_DIM } from './embeddings.js';
import { getConfig } from '../../core/config.js';

export type PointId = string | number;
export type QdrantFilter = { must?: unknown[]; should?: unknown[]; must_not?: unknown[] };
export interface QdrantPoint {
  id: PointId;
  vector?: number[];
  payload?: Record<string, unknown> | null;
}
export interface ScoredPoint extends QdrantPoint {
  score: number;
  version?: number;
}

const QDRANT_TIMEOUT_MS = 10_000; // short timeout to avoid hanging on a cold start

export class QdrantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

export class QdrantClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly apiKey?: string,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['api-key'] = this.apiKey;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === 'TimeoutError' ? `timeout ${QDRANT_TIMEOUT_MS}ms` : String(e);
      throw new QdrantError(`[qdrant] ${method} ${path} failed: ${reason}`, 0);
    }
    const text = await res.text();
    let json: { result?: T; status?: unknown } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const detail = (json?.status as { error?: string } | undefined)?.error ?? text.slice(0, 200);
      throw new QdrantError(`[qdrant] ${method} ${path} ${res.status}: ${detail}`, res.status);
    }
    return json?.result as T;
  }

  private col(name: string): string {
    return `/collections/${encodeURIComponent(name)}`;
  }

  getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return this.call('GET', '/collections');
  }

  /** Collection info. Only the vector size is read here (single unnamed vector). */
  getCollection(name: string): Promise<{ config?: { params?: { vectors?: { size?: number } } } }> {
    return this.call('GET', this.col(name));
  }

  createCollection(name: string, body: Record<string, unknown>): Promise<boolean> {
    return this.call('PUT', this.col(name), body);
  }

  deleteCollection(name: string): Promise<boolean> {
    return this.call('DELETE', this.col(name));
  }

  createPayloadIndex(name: string, body: { field_name: string; field_schema: string; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('PUT', `${this.col(name)}/index?wait=${wait}`, rest);
  }

  upsert(name: string, body: { points: QdrantPoint[]; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('PUT', `${this.col(name)}/points?wait=${wait}`, rest);
  }

  /** Delete by point ids or by filter. Waits by default, like the official client. */
  delete(name: string, body: { points?: PointId[]; filter?: QdrantFilter; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('POST', `${this.col(name)}/points/delete?wait=${wait}`, rest);
  }

  retrieve(name: string, body: { ids: PointId[]; with_payload?: boolean | string[]; with_vector?: boolean }): Promise<QdrantPoint[]> {
    return this.call('POST', `${this.col(name)}/points`, body);
  }

  scroll(
    name: string,
    body: { filter?: QdrantFilter; limit?: number; offset?: PointId; with_payload?: boolean | string[]; with_vector?: boolean },
  ): Promise<{ points: QdrantPoint[]; next_page_offset?: PointId | null }> {
    return this.call('POST', `${this.col(name)}/points/scroll`, body);
  }

  search(
    name: string,
    body: { vector: number[]; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[]; score_threshold?: number },
  ): Promise<ScoredPoint[]> {
    return this.call('POST', `${this.col(name)}/points/search`, body);
  }
}

let _client: QdrantClient | null = null;

// Zero-downtime reindex: env QDRANT_COLLECTION overrides (index into a new collection, then swap the
// env var -> 0 downtime; remove it to roll back). Falls back to config.qdrant.collection.
export const DRIVE_COLLECTION = process.env.QDRANT_COLLECTION || getConfig().qdrant.collection;
// The dimension is defined in embeddings.ts (the model output dimension). Re-exported so the collection size always
// matches the embedding dimension.
export { EMBEDDING_DIM };

/** The vector store the Drive plugin talks to: Qdrant, or the built-in SQLite store with the same methods. */
export type VectorClient = Pick<
  QdrantClient,
  'getCollections' | 'getCollection' | 'createCollection' | 'deleteCollection' | 'createPayloadIndex' | 'upsert' | 'delete' | 'retrieve' | 'scroll' | 'search'
>;

/** Which store is in use: Qdrant when QDRANT_URL is set, otherwise the built-in file (local_vectors.ts). */
export function vectorStoreKind(): 'qdrant' | 'built-in' {
  return process.env.QDRANT_URL?.trim() ? 'qdrant' : 'built-in';
}

/** The vector store (one per process). The name is kept from when Qdrant was the only store. */
export async function getQdrantClient(): Promise<VectorClient> {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) return (await import('./local_vectors.js')).getLocalVectorClient();
  if (_client) return _client;
  _client = new QdrantClient(url, process.env.QDRANT_API_KEY || undefined);
  return _client;
}

/**
 * Creates the collection if it does not exist. Idempotent.
 * Payload fields that are filtered often are registered as indexed payload.
 */
export async function ensureCollection(): Promise<void> {
  const client = await getQdrantClient();
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === DRIVE_COLLECTION);

  if (exists) {
    // A collection built with another embedding model has a different vector size. Writing to it would fail on
    // every point with an unclear error, so stop here and say how to fix it.
    const size = (await client.getCollection(DRIVE_COLLECTION)).config?.params?.vectors?.size;
    if (typeof size === 'number' && size !== EMBEDDING_DIM) {
      throw new Error(
        `[qdrant] collection '${DRIVE_COLLECTION}' holds ${size}-dimension vectors but EMBEDDING_DIM is ${EMBEDDING_DIM}. ` +
          'After changing the embedding model, reindex into a new collection: set QDRANT_COLLECTION to a new name, ' +
          'or run "knowledge-mcp drive reindex --recreate".',
      );
    }
    return;
  }

  await client.createCollection(DRIVE_COLLECTION, {
    vectors: {
      size: EMBEDDING_DIM,
      distance: 'Cosine',
    },
    // HNSW defaults (m=16, ef_construct=100), enough up to 10,000 vectors
    optimizers_config: {
      default_segment_number: 2,
    },
  });

  // Index the payload fields that are filtered often (faster search)
  for (const fieldName of [
    'file_type', 'cluster', 'file_id', 'source',
    // filters on image presence and front matter metadata
    'has_image', 'doc_status',
    // filters on tags, mode and path-derived fields (the doc_tags array matches by keyword per element)
    'doc_tags', 'doc_type', 'doc_category', 'doc_customer',
  ] as const) {
    await client.createPayloadIndex(DRIVE_COLLECTION, {
      field_name: fieldName,
      field_schema: fieldName === 'has_image' ? 'bool' : 'keyword',
    });
  }
}

// A type alias, not an interface: it must be assignable to the Qdrant upsert payload (Record<string, unknown>).
// (An interface is not assignable to an index-signature type because of declaration merging. A type alias is.)
export type ChunkPayload = {
  chunk_id: string;
  file_id: string;
  file_name: string;
  file_path: string;
  heading: string;
  chunk_index: number;
  chunk_count: number; // total chunks of this file, used to delete orphan chunks when a reindex produces fewer.
  content: string;
  modified_time: string;
  content_hash: string; // sha256 of the extracted text, used to skip unchanged reindexing. Same on every chunk.
  file_type: 'dev_log' | 'decision' | 'rule' | 'template' | 'biz' | 'other';
  cluster: string | null;
  source: string;

  // ── Image and structure metadata ──
  image_urls: string[]; // Mathpix CDN (or persisted) image URLs in the chunk
  has_image: boolean; // image_urls.length > 0, for payload filter indexing
  table_count: number; // number of markdown tables in the chunk
  has_code_block: boolean; // whether a ``` fence is present

  // ── Front matter fields (search filters and links) ──
  doc_status: string | null; // frontmatter status (any value; superseded and parked are demoted in search)
  doc_date: string | null; // ISO date
  doc_authors: string[]; // ["alice", "claude"]
  doc_related: string[]; // document-to-document links (related)
  doc_tags: string[]; // tags (dev = front matter tags / biz = derived from path and file name)
  doc_source_refs: string[]; // document-to-code paths (source_refs)
  doc_affects: string[]; // decision → affected status docs (affects)
  doc_products: string[]; // products the document spans
  doc_type: string | null; // e.g. status | decision | history | bug
  doc_confidence: string | null; // HIGH | MEDIUM

  // ── Path-derived fields (biz sources: PDF/docx with no front matter) ──
  doc_category: string | null; // top-level folder (NN_ removed), e.g. Clients, Sales, Finance
  doc_customer: string | null; // {customerFolders}/{name} → customer name (config drive.customerFolders)
}
