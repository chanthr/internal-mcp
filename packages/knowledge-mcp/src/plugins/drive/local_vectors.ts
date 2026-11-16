/**
 * Built-in vector store: a SQLite file, used when QDRANT_URL is not set.
 *
 * Why: semantic search used to need an external Qdrant before it could be tried at all. With this store the only
 * thing left to supply is an embedding key. It has the same methods and return shapes as QdrantClient (qdrant.ts),
 * so the indexer, sync and search code do not know which one they talk to.
 *
 * How it searches: exact cosine similarity over every stored vector (no approximate index). Vectors are kept
 * normalized in one Float32Array in memory, so a query is a single pass of dot products. That is a few milliseconds
 * for 10,000 chunks and well under a second for 100,000. Past that, or when several servers must share one index,
 * set QDRANT_URL and reindex.
 *
 * Point ids are stored as text: chunk ids are 63-bit numbers, which SQLite integers and JS numbers do not share
 * exactly. They come back as the same JS number that went in.
 *
 * Supported filter: `{ must: [{ key, match: { value } }] }`, the only shape the Drive plugin uses. A payload field
 * that holds an array matches when any element equals the value, like Qdrant.
 *
 * File: <data dir>/vectors.db (MCP_DATA_DIR). One process writes to it. Another process (for example a manual
 * `drive reindex` while the server runs) is noticed through SQLite's data_version and the memory copy is reloaded.
 */
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../core/paths.js';
import type { PointId, QdrantFilter, QdrantPoint, ScoredPoint } from './qdrant.js';

type Payload = Record<string, unknown>;
type MustClause = { key?: unknown; match?: { value?: unknown } };

/** Collection names become table names, so only a safe character set is allowed. */
function tableOf(collection: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(collection)) {
    throw new Error(`[vectors] collection name "${collection}" must be letters, digits and underscores (max 64)`);
  }
  return `vec_${collection}`;
}

function matchesFilter(payload: Payload | null, filter: QdrantFilter | undefined): boolean {
  if (filter?.should?.length || filter?.must_not?.length) {
    throw new Error('[vectors] the built-in vector store supports only "must" filters');
  }
  for (const raw of filter?.must ?? []) {
    const c = raw as MustClause;
    if (typeof c.key !== 'string' || !c.match || !('value' in c.match)) {
      throw new Error('[vectors] the built-in vector store supports only { key, match: { value } } clauses');
    }
    const actual = payload?.[c.key];
    const want = c.match.value;
    if (Array.isArray(actual) ? !actual.includes(want) : actual !== want) return false;
  }
  return true;
}

function pickPayload(payload: Payload | null, with_payload: boolean | string[] | undefined): Payload | null | undefined {
  if (with_payload === false) return undefined;
  if (Array.isArray(with_payload)) {
    if (!payload) return null;
    return Object.fromEntries(with_payload.filter((k) => k in payload).map((k) => [k, payload[k]]));
  }
  return payload;
}

/** Normalize to unit length so cosine similarity is a plain dot product. A zero vector stays zero (score 0). */
function normalized(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

interface MemoryIndex {
  dim: number;
  ids: number[];
  payloads: Array<Payload | null>;
  /** ids.length × dim, row after row. */
  matrix: Float32Array;
  dataVersion: number;
}

export class LocalVectorClient {
  private memory = new Map<string, MemoryIndex>();

  constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS vec_collections (name TEXT PRIMARY KEY, dim INTEGER NOT NULL)');
  }

  private dataVersion(): number {
    return Number((this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  }

  private dimOf(name: string): number | undefined {
    const row = this.db.prepare('SELECT dim FROM vec_collections WHERE name = ?').get(name) as { dim: number } | undefined;
    return row?.dim;
  }

  private requireDim(name: string): number {
    const dim = this.dimOf(name);
    if (dim === undefined) throw new Error(`[vectors] collection '${name}' does not exist`);
    return dim;
  }

  async getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return { collections: this.db.prepare('SELECT name FROM vec_collections ORDER BY name').all() as Array<{ name: string }> };
  }

  async getCollection(name: string): Promise<{ config?: { params?: { vectors?: { size?: number } } } }> {
    return { config: { params: { vectors: { size: this.requireDim(name) } } } };
  }

  async createCollection(name: string, body: Record<string, unknown>): Promise<boolean> {
    const size = (body.vectors as { size?: unknown } | undefined)?.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new Error('[vectors] createCollection needs vectors.size');
    const table = tableOf(name);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB NOT NULL)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_file ON ${table} (file_id)`);
    this.db.prepare('INSERT OR REPLACE INTO vec_collections (name, dim) VALUES (?, ?)').run(name, size);
    this.memory.delete(name);
    return true;
  }

  async deleteCollection(name: string): Promise<boolean> {
    this.db.exec(`DROP TABLE IF EXISTS ${tableOf(name)}`);
    this.db.prepare('DELETE FROM vec_collections WHERE name = ?').run(name);
    this.memory.delete(name);
    return true;
  }

  /** Qdrant builds payload indexes here. Nothing to do: filters are applied in memory. */
  async createPayloadIndex(_name: string, _body: { field_name: string; field_schema: string; wait?: boolean }): Promise<unknown> {
    return true;
  }

  async upsert(name: string, body: { points: QdrantPoint[]; wait?: boolean }): Promise<unknown> {
    const dim = this.requireDim(name);
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${tableOf(name)} (id, file_id, payload, vector) VALUES (?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const p of body.points) {
        if (!p.vector || p.vector.length !== dim) {
          throw new Error(`[vectors] vector size ${p.vector?.length ?? 0} does not match collection '${name}' (${dim})`);
        }
        const fileId = typeof p.payload?.file_id === 'string' ? p.payload.file_id : null;
        const vec = normalized(p.vector);
        stmt.run(String(p.id), fileId, JSON.stringify(p.payload ?? null), new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.memory.delete(name);
    return { status: 'completed' };
  }

  async delete(name: string, body: { points?: PointId[]; filter?: QdrantFilter; wait?: boolean }): Promise<unknown> {
    this.requireDim(name);
    const table = tableOf(name);
    if (body.points?.length) {
      const stmt = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const id of body.points) stmt.run(String(id));
    } else if (body.filter) {
      const must = (body.filter.must ?? []) as MustClause[];
      const only = must.length === 1 && !body.filter.should?.length && !body.filter.must_not?.length ? must[0] : undefined;
      if (only && only.key === 'file_id' && typeof only.match?.value === 'string') {
        this.db.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(only.match.value); // the common case, by index
      } else {
        const rows = this.db.prepare(`SELECT id, payload FROM ${table}`).all() as Array<{ id: string; payload: string }>;
        const stmt = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        for (const r of rows) if (matchesFilter(JSON.parse(r.payload) as Payload | null, body.filter)) stmt.run(r.id);
      }
    }
    this.memory.delete(name);
    return { status: 'completed' };
  }

  async retrieve(name: string, body: { ids: PointId[]; with_payload?: boolean | string[]; with_vector?: boolean }): Promise<QdrantPoint[]> {
    this.requireDim(name);
    const stmt = this.db.prepare(`SELECT id, payload FROM ${tableOf(name)} WHERE id = ?`);
    const out: QdrantPoint[] = [];
    for (const id of body.ids) {
      const row = stmt.get(String(id)) as { id: string; payload: string } | undefined;
      if (row) out.push({ id: Number(row.id), payload: pickPayload(JSON.parse(row.payload) as Payload | null, body.with_payload ?? true) });
    }
    return out;
  }

  async scroll(
    name: string,
    body: { filter?: QdrantFilter; limit?: number; offset?: PointId; with_payload?: boolean | string[]; with_vector?: boolean },
  ): Promise<{ points: QdrantPoint[]; next_page_offset?: PointId | null }> {
    this.requireDim(name);
    const limit = body.limit ?? 10;
    const rows = this.db
      .prepare(`SELECT rowid AS rid, id, payload FROM ${tableOf(name)} WHERE rowid >= ? ORDER BY rowid`)
      .iterate(body.offset === undefined ? 0 : Number(body.offset)) as Iterable<{ rid: number; id: string; payload: string }>;
    const points: QdrantPoint[] = [];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Payload | null;
      if (!matchesFilter(payload, body.filter)) continue;
      if (points.length === limit) return { points, next_page_offset: r.rid }; // the paging cursor is the row number, not a point id
      points.push({ id: Number(r.id), payload: pickPayload(payload, body.with_payload ?? true) });
    }
    return { points, next_page_offset: null };
  }

  private load(name: string): MemoryIndex {
    const version = this.dataVersion();
    const cached = this.memory.get(name);
    if (cached && cached.dataVersion === version) return cached;
    const dim = this.requireDim(name);
    const rows = this.db.prepare(`SELECT id, payload, vector FROM ${tableOf(name)} ORDER BY rowid`).all() as Array<{
      id: string;
      payload: string;
      vector: Uint8Array;
    }>;
    const matrix = new Float32Array(rows.length * dim);
    const ids: number[] = [];
    const payloads: Array<Payload | null> = [];
    rows.forEach((r, i) => {
      // Copy out of the row buffer: its byte offset is not guaranteed to be aligned for a Float32Array view.
      const bytes = new Uint8Array(r.vector);
      matrix.set(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + dim * 4)), i * dim);
      ids.push(Number(r.id));
      payloads.push(JSON.parse(r.payload) as Payload | null);
    });
    const index = { dim, ids, payloads, matrix, dataVersion: version };
    this.memory.set(name, index);
    return index;
  }

  async search(
    name: string,
    body: { vector: number[]; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[]; score_threshold?: number },
  ): Promise<ScoredPoint[]> {
    const { dim, ids, payloads, matrix } = this.load(name);
    if (body.vector.length !== dim) {
      throw new Error(`[vectors] query vector size ${body.vector.length} does not match collection '${name}' (${dim})`);
    }
    const q = normalized(body.vector);
    const scored: Array<{ i: number; score: number }> = [];
    for (let i = 0; i < ids.length; i++) {
      if (!matchesFilter(payloads[i], body.filter)) continue;
      let dot = 0;
      const base = i * dim;
      for (let j = 0; j < dim; j++) dot += matrix[base + j] * q[j];
      if (body.score_threshold !== undefined && dot < body.score_threshold) continue;
      scored.push({ i, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, body.limit).map(({ i, score }) => ({
      id: ids[i],
      score,
      payload: pickPayload(payloads[i], body.with_payload ?? false),
    }));
  }
}

let _local: LocalVectorClient | null = null;

/** Path of the built-in vector file. */
export function localVectorPath(): string {
  return join(dataDir(), 'vectors.db');
}

export async function getLocalVectorClient(): Promise<LocalVectorClient> {
  if (_local) return _local;
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const orig = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite is an experimental feature')) return;
    return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    _local = new LocalVectorClient(new DatabaseSync(localVectorPath()));
  } finally {
    process.emitWarning = orig;
  }
  return _local;
}
