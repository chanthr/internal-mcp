/**
 * Built-in index: a SQLite file, used when QDRANT_URL is not set. It holds every indexed chunk, a keyword index
 * over the chunk text, and the chunk's vector when an embedding model is configured.
 *
 * Why: search used to need an external Qdrant and an embedding key before it could be tried at all. With this store
 * nothing has to be supplied: keyword search works on its own, and vectors are an optional addition. It has the same
 * methods and return shapes as QdrantClient (qdrant.ts), so the indexer and sync code do not know which one they
 * talk to, plus a few methods that only exist here (keyword search, vectors added later).
 *
 * Keyword search: SQLite FTS5 ranked with BM25, over tokens from tokens.ts (words, and character pairs for CJK).
 * The FTS table stores no text of its own (contentless), only the index, and is kept in step with the chunk table
 * on every write. If the two ever disagree, the keyword index is rebuilt from the chunks.
 *
 * Vector search: exact cosine similarity over every stored vector (no approximate index). Vectors are kept
 * normalized in one Float32Array in memory, so a query is a single pass of dot products. That is a few milliseconds
 * for 10,000 chunks and well under a second for 100,000. Past that, or when several servers must share one index,
 * set QDRANT_URL and reindex.
 *
 * Point ids are stored as text: chunk ids are 63-bit numbers, which SQLite integers and JS numbers do not share
 * exactly. They come back as the same JS number that went in.
 *
 * Supported filter: `{ must: [{ key, match: { value } }] }`, the only shape the plugins use. A payload field that
 * holds an array matches when any element equals the value, like Qdrant.
 *
 * File: <data dir>/vectors.db (MCP_DATA_DIR). Several processes may use it (the server, a manual reindex, stdio
 * sessions). A write by another process is noticed through SQLite's data_version and the memory copy is reloaded.
 */
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../core/paths.js';
import type { PointId, QdrantFilter, QdrantPoint, ScoredPoint } from './qdrant.js';
import { ftsQuery, tokenText } from './tokens.js';

type Payload = Record<string, unknown>;
type MustClause = { key?: unknown; match?: { value?: unknown } };

/** Collection names become table names, so only a safe character set is allowed. */
function safeName(collection: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(collection)) {
    throw new Error(`[index] collection name "${collection}" must be letters, digits and underscores (max 64)`);
  }
  return collection;
}
const tableOf = (collection: string) => `vec_${safeName(collection)}`;
const ftsOf = (collection: string) => `fts_${safeName(collection)}`;

function matchesFilter(payload: Payload | null, filter: QdrantFilter | undefined): boolean {
  if (filter?.should?.length || filter?.must_not?.length) {
    throw new Error('[index] the built-in index supports only "must" filters');
  }
  for (const raw of filter?.must ?? []) {
    const c = raw as MustClause;
    if (typeof c.key !== 'string' || !c.match || !('value' in c.match)) {
      throw new Error('[index] the built-in index supports only { key, match: { value } } clauses');
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

const blobOf = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** The text the keyword index sees for a chunk: file name, heading and body. */
function searchableText(payload: Payload | null | undefined): string {
  const s = (k: string) => (typeof payload?.[k] === 'string' ? (payload[k] as string) : '');
  return `${s('file_name')}\n${s('heading')}\n${s('content')}`;
}

interface MemoryIndex {
  dim: number;
  /** Chunk ids as stored, in row order. */
  ids: string[];
  /** The row number of each chunk, for looking up its metadata. */
  rows: number[];
  /** Every vector, one after the other, normalized. */
  matrix: Float32Array;
  dataVersion: number;
}

/** Chunk metadata without the text, by row number: what a filter looks at. */
interface MetaIndex {
  byRow: Map<number, Payload | null>;
  dataVersion: number;
}

/** How far down the keyword ranking a filtered search reads before it gives up finding more that pass. */
const KEYWORD_FILTER_SCAN = 50_000;

export class LocalVectorClient {
  private memory = new Map<string, MemoryIndex>();
  private meta = new Map<string, MetaIndex>();
  private checked = new Set<string>();

  constructor(private readonly db: DatabaseSync) {
    // Several processes can write here (the server, a manual `drive reindex`, stdio sessions). Without a timeout
    // the second writer fails at once with "database is locked".
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000');
    db.exec('CREATE TABLE IF NOT EXISTS vec_collections (name TEXT PRIMARY KEY, dim INTEGER NOT NULL)');
    // Which model made the stored vectors. Added later, so a file from an older version gets the column here.
    const cols = db.prepare('PRAGMA table_info(vec_collections)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'model')) {
      try {
        db.exec('ALTER TABLE vec_collections ADD COLUMN model TEXT');
      } catch {
        /* another process added it first */
      }
    }
  }

  /** After a write: what was read into memory is no longer what the file holds. */
  private forget(name: string): void {
    this.memory.delete(name);
    this.meta.delete(name);
  }

  private dataVersion(): number {
    return Number((this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  }

  private dimOf(name: string): number | undefined {
    const row = this.db.prepare('SELECT dim FROM vec_collections WHERE name = ?').get(name) as { dim: number } | undefined;
    return row?.dim;
  }

  /**
   * The collection's vector size. Also makes sure, once per process, that the tables are in their current shape
   * and that the keyword index covers every chunk (a file written by an older version has no keyword index yet).
   */
  private requireDim(name: string): number {
    const dim = this.dimOf(name);
    if (dim === undefined) throw new Error(`[index] collection '${name}' does not exist`);
    if (!this.checked.has(name)) {
      this.createTables(name);
      this.syncKeywordIndex(name);
      this.checked.add(name);
    }
    return dim;
  }

  private createTables(name: string): void {
    const table = tableOf(name);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB)`);
    // An earlier layout required a vector on every row. Chunks may now be stored before they have one.
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    if (cols.some((c) => c.name === 'vector' && c.notnull === 1)) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
        this.db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB)`);
        this.db.exec(`INSERT INTO ${table} (id, file_id, payload, vector) SELECT id, file_id, payload, vector FROM ${table}_old`);
        this.db.exec(`DROP TABLE ${table}_old`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_file ON ${table} (file_id)`);
    // The chunks that still wait for a vector, and nothing else. Finding the next batch to embed, and counting how
    // many are left, read this small index instead of walking the whole table past every chunk that is done.
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_novec ON ${table} (file_id) WHERE vector IS NULL`);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsOf(name)} USING fts5(tokens, content='', contentless_delete=1)`);
  }

  /** Rebuild the keyword index when it does not cover exactly the chunks in the table. */
  private syncKeywordIndex(name: string): void {
    const table = tableOf(name);
    const fts = ftsOf(name);
    const chunks = (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const indexed = (this.db.prepare(`SELECT count(*) AS n FROM ${fts}`).get() as { n: number }).n;
    if (chunks === indexed) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DROP TABLE ${fts}`);
      this.db.exec(`CREATE VIRTUAL TABLE ${fts} USING fts5(tokens, content='', contentless_delete=1)`);
      const ins = this.db.prepare(`INSERT INTO ${fts} (rowid, tokens) VALUES (?, ?)`);
      const rows = this.db.prepare(`SELECT rowid AS rid, payload FROM ${table}`).all() as Array<{ rid: number; payload: string }>;
      for (const r of rows) ins.run(r.rid, tokenText(searchableText(JSON.parse(r.payload) as Payload | null)));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return { collections: this.db.prepare('SELECT name FROM vec_collections ORDER BY name').all() as Array<{ name: string }> };
  }

  async getCollection(name: string): Promise<{ config?: { params?: { vectors?: { size?: number } } } }> {
    return { config: { params: { vectors: { size: this.requireDim(name) } } } };
  }

  async createCollection(name: string, body: Record<string, unknown>): Promise<boolean> {
    const size = (body.vectors as { size?: unknown } | undefined)?.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new Error('[index] createCollection needs vectors.size');
    this.createTables(name);
    this.db.prepare('INSERT OR REPLACE INTO vec_collections (name, dim) VALUES (?, ?)').run(name, size);
    this.forget(name);
    this.checked.add(name);
    return true;
  }

  async deleteCollection(name: string): Promise<boolean> {
    this.db.exec(`DROP TABLE IF EXISTS ${tableOf(name)}`);
    this.db.exec(`DROP TABLE IF EXISTS ${ftsOf(name)}`);
    this.db.prepare('DELETE FROM vec_collections WHERE name = ?').run(name);
    this.forget(name);
    this.checked.delete(name);
    return true;
  }

  /** Qdrant builds payload indexes here. Nothing to do: filters are applied in memory. */
  async createPayloadIndex(_name: string, _body: { field_name: string; field_schema: string; wait?: boolean }): Promise<unknown> {
    return true;
  }

  /** Remove rows by their row numbers, from the chunk table and the keyword index together. */
  private removeRows(name: string, rowids: number[]): void {
    if (rowids.length === 0) return;
    const delRow = this.db.prepare(`DELETE FROM ${tableOf(name)} WHERE rowid = ?`);
    const delFts = this.db.prepare(`DELETE FROM ${ftsOf(name)} WHERE rowid = ?`);
    for (const rid of rowids) {
      delFts.run(rid);
      delRow.run(rid);
    }
  }

  /** A point without a vector is stored for keyword search only; its vector can be added later (setVectors). */
  async upsert(name: string, body: { points: QdrantPoint[]; wait?: boolean }): Promise<unknown> {
    const dim = this.requireDim(name);
    const table = tableOf(name);
    const find = this.db.prepare(`SELECT rowid AS rid FROM ${table} WHERE id = ?`);
    const ins = this.db.prepare(`INSERT INTO ${table} (id, file_id, payload, vector) VALUES (?, ?, ?, ?)`);
    const insFts = this.db.prepare(`INSERT INTO ${ftsOf(name)} (rowid, tokens) VALUES (?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const p of body.points) {
        if (p.vector && p.vector.length !== dim) {
          throw new Error(`[index] vector size ${p.vector.length} does not match collection '${name}' (${dim})`);
        }
        const id = String(p.id);
        const old = find.get(id) as { rid: number } | undefined;
        if (old) this.removeRows(name, [old.rid]);
        const fileId = typeof p.payload?.file_id === 'string' ? p.payload.file_id : null;
        const info = ins.run(id, fileId, JSON.stringify(p.payload ?? null), p.vector ? blobOf(normalized(p.vector)) : null);
        insFts.run(Number(info.lastInsertRowid), tokenText(searchableText(p.payload)));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.forget(name);
    return { status: 'completed' };
  }

  async delete(name: string, body: { points?: PointId[]; filter?: QdrantFilter; wait?: boolean }): Promise<unknown> {
    this.requireDim(name);
    const table = tableOf(name);
    let rowids: number[] = [];
    if (body.points?.length) {
      const find = this.db.prepare(`SELECT rowid AS rid FROM ${table} WHERE id = ?`);
      for (const id of body.points) {
        const r = find.get(String(id)) as { rid: number } | undefined;
        if (r) rowids.push(r.rid);
      }
    } else if (body.filter) {
      const must = (body.filter.must ?? []) as MustClause[];
      const only = must.length === 1 && !body.filter.should?.length && !body.filter.must_not?.length ? must[0] : undefined;
      if (only && only.key === 'file_id' && typeof only.match?.value === 'string') {
        // the common case, by index
        rowids = (this.db.prepare(`SELECT rowid AS rid FROM ${table} WHERE file_id = ?`).all(only.match.value) as Array<{ rid: number }>).map((r) => r.rid);
      } else {
        const rows = this.db.prepare(`SELECT rowid AS rid, payload FROM ${table}`).all() as Array<{ rid: number; payload: string }>;
        rowids = rows.filter((r) => matchesFilter(JSON.parse(r.payload) as Payload | null, body.filter)).map((r) => r.rid);
      }
    }
    this.db.exec('BEGIN');
    try {
      this.removeRows(name, rowids);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.forget(name);
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
    const from = body.offset === undefined ? 0 : Number(body.offset);
    const must = (body.filter?.must ?? []) as MustClause[];
    const oneFile = must.length === 1 && !body.filter?.should?.length && !body.filter?.must_not?.length && must[0].key === 'file_id' && typeof must[0].match?.value === 'string';
    // When only a few fields are asked for and nothing is filtered, the database picks them out: the chunk text is
    // most of every row, and reading it into the server only to drop it made paging through an index slow.
    const keys = Array.isArray(body.with_payload) && !body.filter && body.with_payload.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) ? body.with_payload : null;
    const column = keys ? `json_object(${keys.map((k) => `'${k}', json_extract(payload, '$.${k}')`).join(', ')}) AS payload` : 'payload';
    const rows = (
      oneFile
        ? this.db.prepare(`SELECT rowid AS rid, id, ${column} FROM ${tableOf(name)} WHERE file_id = ? AND rowid >= ? ORDER BY rowid`).iterate(must[0].match!.value as string, from)
        : this.db.prepare(`SELECT rowid AS rid, id, ${column} FROM ${tableOf(name)} WHERE rowid >= ? ORDER BY rowid`).iterate(from)
    ) as Iterable<{ rid: number; id: string; payload: string }>;
    const points: QdrantPoint[] = [];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Payload | null;
      if (!matchesFilter(payload, body.filter)) continue;
      if (points.length === limit) return { points, next_page_offset: r.rid }; // the paging cursor is the row number, not a point id
      points.push({ id: Number(r.id), payload: pickPayload(payload, body.with_payload ?? true) });
    }
    return { points, next_page_offset: null };
  }

  /**
   * Every vector in one array, for search. Only the vectors: a chunk's text and metadata stay in the file and are
   * read for the few chunks a search returns. (Loading them too held the whole index in memory a second time.)
   */
  private load(name: string): MemoryIndex {
    const version = this.dataVersion();
    const cached = this.memory.get(name);
    if (cached && cached.dataVersion === version) return cached;
    const dim = this.requireDim(name);
    const table = tableOf(name);
    // One snapshot for the count and the rows, so the array is exactly as long as what is read into it.
    this.db.exec('BEGIN');
    let index: MemoryIndex;
    try {
      const n = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE vector IS NOT NULL`).get() as { n: number }).n);
      const matrix = new Float32Array(n * dim);
      const bytes = new Uint8Array(matrix.buffer);
      const ids: string[] = new Array(n);
      const rows: number[] = new Array(n);
      let i = 0;
      const stored = this.db.prepare(`SELECT rowid AS rid, id, vector FROM ${table} WHERE vector IS NOT NULL ORDER BY rowid`).iterate() as Iterable<{
        rid: number;
        id: string;
        vector: Uint8Array;
      }>;
      for (const r of stored) {
        if (i === n) break;
        // Copied as bytes: a row's buffer is not guaranteed to start where a Float32Array could view it.
        bytes.set(r.vector.subarray(0, dim * 4), i * dim * 4);
        rows[i] = Number(r.rid);
        ids[i++] = r.id;
      }
      index = { dim, ids, rows, matrix, dataVersion: version };
    } finally {
      this.db.exec('COMMIT');
    }
    this.memory.set(name, index);
    return index;
  }

  /**
   * Chunk metadata without the text, by row number: what a filter needs to look at. Read the first time a search
   * has a filter and kept until the index changes. A search without a filter never needs it.
   */
  private metadata(name: string): Map<number, Payload | null> {
    const version = this.dataVersion();
    const cached = this.meta.get(name);
    if (cached && cached.dataVersion === version) return cached.byRow;
    const byRow = new Map<number, Payload | null>();
    const stored = this.db.prepare(`SELECT rowid AS rid, json_remove(payload, '$.content') AS payload FROM ${tableOf(name)}`).iterate() as Iterable<{ rid: number; payload: string | null }>;
    for (const r of stored) byRow.set(Number(r.rid), r.payload ? (JSON.parse(r.payload) as Payload | null) : null);
    this.meta.set(name, { byRow, dataVersion: version });
    return byRow;
  }

  /** Vector search. Only chunks that have a vector take part. */
  async search(
    name: string,
    body: { vector: number[]; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[]; score_threshold?: number },
  ): Promise<ScoredPoint[]> {
    const { dim, ids, rows, matrix } = this.load(name);
    if (body.vector.length !== dim) {
      throw new Error(`[index] query vector size ${body.vector.length} does not match collection '${name}' (${dim})`);
    }
    const q = normalized(body.vector);
    const filtered = !!(body.filter?.must?.length || body.filter?.should?.length || body.filter?.must_not?.length);
    const meta = filtered ? this.metadata(name) : null;
    // The best `limit` are kept as they are found (sorted, best first): one pass, and no list of every score to sort.
    const k = Math.max(0, Math.min(body.limit, ids.length));
    const topScore = new Float64Array(k);
    const topRow = new Int32Array(k);
    let kept = 0;
    const floor = body.score_threshold ?? -Infinity;
    for (let i = 0; i < ids.length && k > 0; i++) {
      if (meta && !matchesFilter(meta.get(rows[i]) ?? null, body.filter)) continue;
      const base = i * dim;
      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      let d3 = 0;
      let j = 0;
      for (; j + 3 < dim; j += 4) {
        d0 += matrix[base + j] * q[j];
        d1 += matrix[base + j + 1] * q[j + 1];
        d2 += matrix[base + j + 2] * q[j + 2];
        d3 += matrix[base + j + 3] * q[j + 3];
      }
      for (; j < dim; j++) d0 += matrix[base + j] * q[j];
      const dot = d0 + d1 + d2 + d3;
      if (dot < floor || (kept === k && dot <= topScore[k - 1])) continue;
      let at = kept < k ? kept++ : k - 1;
      while (at > 0 && topScore[at - 1] < dot) {
        topScore[at] = topScore[at - 1];
        topRow[at] = topRow[at - 1];
        at--;
      }
      topScore[at] = dot;
      topRow[at] = i;
    }
    const want = body.with_payload ?? false;
    const read = want === false ? null : this.db.prepare(`SELECT payload FROM ${tableOf(name)} WHERE id = ?`);
    const out: ScoredPoint[] = [];
    for (let r = 0; r < kept; r++) {
      const id = ids[topRow[r]];
      const row = read ? (read.get(id) as { payload: string } | undefined) : undefined;
      out.push({ id: Number(id), score: topScore[r], payload: pickPayload(row ? (JSON.parse(row.payload) as Payload | null) : null, want) });
    }
    return out;
  }

  // ── Only in the built-in index ──

  /**
   * Keyword search, best match first. `score` is the BM25 relevance (higher is better); it is only comparable
   * within one result list.
   */
  async keywordSearch(
    name: string,
    body: { query: string; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[] },
  ): Promise<ScoredPoint[]> {
    this.requireDim(name);
    const match = ftsQuery(body.query);
    if (!match) return [];
    const table = tableOf(name);
    const fts = ftsOf(name);
    const filtered = !!(body.filter?.must?.length || body.filter?.should?.length || body.filter?.must_not?.length);
    // The ranking is read as row numbers only, and the text is read for the chunks that are returned. (Ranking the
    // chunks together with their text made the database carry every candidate's text through its sort.)
    // A filter is applied after ranking, down a generous stretch of it, so a filter that few chunks pass still
    // finds them; the stretch is bounded so a filter nothing passes does not walk a huge index for every query.
    const ranked = this.db
      .prepare(`SELECT rowid AS rid, bm25(${fts}) AS rank FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT ?`)
      .all(match, filtered ? KEYWORD_FILTER_SCAN : body.limit) as Array<{ rid: number; rank: number }>;
    const meta = filtered ? this.metadata(name) : null;
    const read = this.db.prepare(`SELECT id, payload FROM ${table} WHERE rowid = ?`);
    const out: ScoredPoint[] = [];
    for (const r of ranked) {
      if (meta && !matchesFilter(meta.get(Number(r.rid)) ?? null, body.filter)) continue;
      const row = read.get(r.rid) as { id: string; payload: string } | undefined;
      if (!row) continue;
      out.push({ id: Number(row.id), score: -r.rank, payload: pickPayload(JSON.parse(row.payload) as Payload | null, body.with_payload ?? true) }); // bm25() is smaller for better matches
      if (out.length === body.limit) break;
    }
    return out;
  }

  /** How many chunks there are, and how many of them still wait for a vector. Both read an index, not the table. */
  private counts(name: string): { chunks: number; missing: number } {
    const table = tableOf(name);
    const chunks = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    const missing = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE vector IS NULL`).get() as { n: number }).n);
    return { chunks, missing };
  }

  /** How much is indexed: chunks, chunks that have a vector, and distinct documents. */
  async stats(name: string): Promise<{ chunks: number; withVectors: number; documents: number }> {
    if (this.dimOf(name) === undefined) return { chunks: 0, withVectors: 0, documents: 0 };
    this.requireDim(name);
    const { chunks, missing } = this.counts(name);
    const documents = Number((this.db.prepare(`SELECT count(DISTINCT file_id) AS n FROM ${tableOf(name)}`).get() as { n: number }).n);
    return { chunks, withVectors: chunks - missing, documents };
  }

  /**
   * Every indexed document with the modified time recorded for it, optionally only ids that start with `prefix`.
   * One row is read per document (its first chunk), not one per chunk.
   */
  async documentTimes(name: string, prefix = ''): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (this.dimOf(name) === undefined) return out;
    this.requireDim(name);
    const table = tableOf(name);
    const rows = this.db
      .prepare(
        `SELECT file_id, json_extract(payload, '$.modified_time') AS modified FROM ${table} ` +
          `WHERE rowid IN (SELECT min(rowid) FROM ${table} WHERE file_id >= ? AND file_id < ? GROUP BY file_id)`,
      )
      .iterate(prefix, `${prefix}\u{10FFFF}`) as Iterable<{ file_id: string | null; modified: string | null }>;
    for (const r of rows) if (r.file_id) out.set(r.file_id, r.modified ?? '');
    return out;
  }

  /** The chunks of one document, found through the document index. Not in document order. */
  async documentChunks(name: string, fileId: string): Promise<Array<Payload | null>> {
    if (this.dimOf(name) === undefined) return [];
    this.requireDim(name);
    const rows = this.db.prepare(`SELECT payload FROM ${tableOf(name)} WHERE file_id = ?`).all(fileId) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Payload | null);
  }

  /**
   * The values a metadata field takes over the whole index, most frequent first, counted in documents. For telling
   * a caller whose filter matched nothing what it could have asked for.
   */
  async fieldValues(name: string, key: string, limit = 12): Promise<Array<{ value: string; documents: number }>> {
    if (this.dimOf(name) === undefined) return [];
    this.requireDim(name);
    const docs = new Map<string, Set<string>>();
    for (const p of this.metadata(name).values()) {
      const raw = p?.[key];
      const file = typeof p?.file_id === 'string' ? p.file_id : '';
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        if (typeof v !== 'string' || !v) continue;
        let set = docs.get(v);
        if (!set) docs.set(v, (set = new Set()));
        set.add(file);
      }
    }
    return [...docs.entries()].map(([value, set]) => ({ value, documents: set.size })).sort((a, b) => b.documents - a.documents || a.value.localeCompare(b.value)).slice(0, limit);
  }

  /** How many documents have an id that starts with `prefix` (the documents of one local folder). */
  async countDocuments(name: string, prefix: string): Promise<number> {
    if (this.dimOf(name) === undefined) return 0;
    this.requireDim(name);
    const r = this.db.prepare(`SELECT count(DISTINCT file_id) AS n FROM ${tableOf(name)} WHERE file_id >= ? AND file_id < ?`).get(prefix, `${prefix}\u{10FFFF}`) as { n: number };
    return Number(r.n);
  }

  /**
   * What the stored vectors are: their size, the model that made them (null when unknown or none yet), and how many
   * chunks have one. Null when the collection does not exist.
   */
  async embeddingState(name: string): Promise<{ dim: number; model: string | null; vectors: number } | null> {
    const row = this.db.prepare('SELECT dim, model FROM vec_collections WHERE name = ?').get(name) as { dim: number; model: string | null } | undefined;
    if (!row) return null;
    this.requireDim(name);
    // Counted, not loaded: this is asked on every search and every status read, and loading every vector to count
    // them cost hundreds of megabytes each time the index had changed.
    const { chunks, missing } = this.counts(name);
    return { dim: row.dim, model: row.model ?? null, vectors: chunks - missing };
  }

  /**
   * Change the collection's vector size. Only while no chunk has a vector: an index built for keyword search was
   * created with whatever size was the default then, and takes the size of the model that is added later.
   */
  async adoptDimension(name: string, dim: number): Promise<void> {
    const state = await this.embeddingState(name);
    if (!state) return;
    if (state.vectors > 0) throw new Error(`[index] collection '${name}' holds vectors; clear them before changing the size`);
    this.db.prepare('UPDATE vec_collections SET dim = ?, model = NULL WHERE name = ?').run(dim, name);
    this.forget(name);
  }

  /** Remember which model made the vectors, so a later change of model is noticed instead of mixing two models. */
  async noteModel(name: string, model: string): Promise<void> {
    this.db.prepare('UPDATE vec_collections SET model = ? WHERE name = ? AND model IS NOT ?').run(model, name, model);
  }

  /**
   * Drop every vector and set the size for the next model. The chunk text and the keyword index stay, so vectors
   * can be made again from what is stored. Returns how many chunks lost their vector.
   */
  async clearVectors(name: string, dim: number): Promise<number> {
    this.requireDim(name);
    const r = this.db.prepare(`UPDATE ${tableOf(name)} SET vector = NULL WHERE vector IS NOT NULL`).run();
    this.db.prepare('UPDATE vec_collections SET dim = ?, model = NULL WHERE name = ?').run(dim, name);
    this.forget(name);
    return Number(r.changes);
  }

  /** Chunks stored without a vector (indexed before an embedding model was configured). */
  async missingVectors(name: string, limit: number): Promise<Array<{ id: number; payload: Payload | null }>> {
    this.requireDim(name);
    // Through the index of chunks without a vector: the cost is the batch, however many chunks are already done.
    const rows = this.db.prepare(`SELECT id, payload FROM ${tableOf(name)} WHERE vector IS NULL LIMIT ?`).all(limit) as Array<{
      id: string;
      payload: string;
    }>;
    return rows.map((r) => ({ id: Number(r.id), payload: JSON.parse(r.payload) as Payload | null }));
  }

  /** Add vectors to chunks that are already stored. The chunk text and the keyword index are untouched. */
  async setVectors(name: string, vectors: Array<{ id: PointId; vector: number[] }>): Promise<void> {
    const dim = this.requireDim(name);
    const stmt = this.db.prepare(`UPDATE ${tableOf(name)} SET vector = ? WHERE id = ?`);
    this.db.exec('BEGIN');
    try {
      for (const v of vectors) {
        if (v.vector.length !== dim) throw new Error(`[index] vector size ${v.vector.length} does not match collection '${name}' (${dim})`);
        stmt.run(blobOf(normalized(v.vector)), String(v.id));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.forget(name);
  }
}

let _local: LocalVectorClient | null = null;

/** Path of the built-in index file. */
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
