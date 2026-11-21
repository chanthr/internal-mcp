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
 * on every write. If the two ever disagree, the keyword index is rebuilt from the chunks. In a large index a long
 * question is searched by its rarer words only (keywordTerms): a word in most passages matches nearly all of them,
 * and ranking every match made one question block the server for hundreds of milliseconds.
 *
 * Vector search: exact cosine similarity over every stored vector (no approximate index). Vectors are kept
 * normalized in one Float32Array in memory, so a query is a single pass of dot products. That is a few milliseconds
 * for 10,000 chunks and well under a second for 100,000. Past that, or when several servers must share one index,
 * set QDRANT_URL and reindex.
 *
 * The memory copies (the vectors, and the metadata fields filters look at) are read once and then kept up to date
 * by every write this process makes: a new vector goes into spare room at the end, a changed one is overwritten
 * where it is, and a removed one is marked and squeezed out later. Reading everything again after each write made
 * every "add a document, then search" allocate a whole new array; on macOS the freed ones were not reused, so memory
 * grew by the size of the index each time, to gigabytes while vectors were being filled in.
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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../core/paths.js';
import type { PointId, QdrantFilter, QdrantPoint, ScoredPoint } from './qdrant.js';
import { matchExpression, queryTerms, tokenText } from './tokens.js';

type Payload = Record<string, unknown>;
type MustClause = { key?: unknown; match?: { value?: unknown } };
type Clause = { key: string; value: unknown };

/** Collection names become table names, so only a safe character set is allowed. */
function safeName(collection: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(collection)) {
    throw new Error(`[index] collection name "${collection}" must be letters, digits and underscores (max 64)`);
  }
  return collection;
}
const tableOf = (collection: string) => `vec_${safeName(collection)}`;
const ftsOf = (collection: string) => `fts_${safeName(collection)}`;
/** Per-connection view of the keyword index's words and how many passages hold each (fts5vocab). */
const vocabOf = (collection: string) => `vocab_${safeName(collection)}`;

/** The clauses of a filter, checked once: only `must`, and only `{ key, match: { value } }`. */
function mustClauses(filter: QdrantFilter | undefined): Clause[] {
  if (filter?.should?.length || filter?.must_not?.length) {
    throw new Error('[index] the built-in index supports only "must" filters');
  }
  return (filter?.must ?? []).map((raw) => {
    const c = raw as MustClause;
    if (typeof c.key !== 'string' || !c.match || !('value' in c.match)) {
      throw new Error('[index] the built-in index supports only { key, match: { value } } clauses');
    }
    return { key: c.key, value: c.match.value };
  });
}

/** One field against one wanted value. A field that holds an array matches when any element does, like Qdrant. */
const matches = (actual: unknown, want: unknown): boolean => (Array.isArray(actual) ? actual.includes(want) : actual === want);

function matchesFilter(payload: Payload | null, clauses: Clause[]): boolean {
  for (const c of clauses) if (!matches(payload?.[c.key], c.value)) return false;
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

/**
 * Every vector of a collection in memory. A vector has a slot: its numbers are at slot × dim in `matrix`. Slots
 * past `size` are spare room for vectors added later.
 */
interface MemoryIndex {
  dim: number;
  /** Room for `capacity` vectors, one after the other, normalized. The first `size` slots are in use. */
  matrix: Float32Array;
  capacity: number;
  size: number;
  /** By slot: the chunk id as stored. */
  ids: string[];
  /** By slot: the chunk's row number, or -1 when the chunk is gone and the slot waits to be squeezed out. */
  rows: number[];
  /** The slot of each row number that has a vector here. */
  slotOf: Map<number, number>;
  /** Slots marked -1 in `rows`. */
  dead: number;
  dataVersion: number;
  count: Reads;
}

/** How often a collection's memory copies were read from the file, and how many vector arrays were made for it. */
interface Reads {
  loads: number;
  allocations: number;
  metadataLoads: number;
}

/**
 * One metadata field of every chunk, compactly: each distinct value is kept once, and each chunk holds only the
 * number of its value. (A whole payload per chunk took about 1.35 KB each, a hundred megabytes for 70,000.)
 */
interface MetaColumn {
  /** By slot: the index of the chunk's value in `values`. 0 is "the chunk has no such field". */
  codes: Int32Array;
  values: unknown[];
  /** The index of each value in `values`: a string, number, boolean or null by itself, an array or object by its JSON. */
  plain: Map<unknown, number>;
  json: Map<string, number>;
}

/** The metadata fields filters look at, for every chunk, by row number. */
interface MetaIndex {
  /** The slot of each row number. */
  slotOf: Map<number, number>;
  /** Slots of removed chunks, given to the next new ones. */
  free: number[];
  /** Slots handed out so far; the columns have room for `capacity`. */
  size: number;
  capacity: number;
  columns: Map<string, MetaColumn>;
  dataVersion: number;
}

/** A change one write made, in the order it made them, for the memory copies. */
type WriteOp =
  | { kind: 'remove'; rid: number }
  | { kind: 'add'; rid: number; id: string; vector: Float32Array | null; payload: Payload | null }
  | { kind: 'vector'; rid: number; id: string; vector: Float32Array };

/** How far down the keyword ranking a filtered search reads before it gives up finding more that pass. */
const KEYWORD_FILTER_SCAN = 50_000;

/**
 * When the vectors no longer fit, the room grows to this many times what it was. Fewer, larger steps leave fewer
 * freed arrays behind while an index fills; the spare room is not touched until it is used.
 */
const GROWTH = 1.5;
/** Spare room given when the vectors are read: for the next documents, so a single new one does not grow it. */
const headroom = (n: number) => Math.max(64, Math.ceil(n / 16));

/**
 * The metadata fields kept for filters: the ones search_knowledge.ts and agent_search.ts filter on, and file_id for
 * counting documents. A filter on any other field adds that field the first time it is asked for.
 */
const META_FIELDS = ['file_id', 'source', 'cluster', 'has_image', 'doc_status', 'doc_tags', 'doc_type', 'doc_category', 'doc_customer'];

/** Keyword search keeps every word of a question below this many passages: there, even a long question is fast. */
const KEYWORD_TRIM_FROM = 5_000;
/** A word found in more than this share of the passages is dropped from a question while rarer words remain. */
const KEYWORD_COMMON_SHARE = 0.2;
/** At most this many words of a question are searched for: the rarest. */
const KEYWORD_MAX_TERMS = 16;

/**
 * How long a chunk the embedding endpoint refused is left out of missingVectors. Then it is tried again: an endpoint
 * that refused it may have changed (another model behind the same name, a larger context, another address).
 */
const REFUSAL_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * The pieces FTS5's tokenizer (unicode61) makes of a word from tokens.ts: it splits at anything but letters and
 * digits, "_" included, and drops accents from Latin letters. "search_knowledge" is held as "search" and
 * "knowledge", "café" as "cafe".
 */
function ftsPieces(term: string): string[] {
  return term
    .replace(/\p{Script=Latin}/gu, (c) => c.normalize('NFD').replace(/\p{M}/gu, ''))
    .split(/[^\p{L}\p{N}\p{Co}]+/u)
    .filter(Boolean);
}

const newColumn = (capacity: number): MetaColumn => ({ codes: new Int32Array(capacity), values: [undefined], plain: new Map(), json: new Map() });

/**
 * The number of a payload field's value in a metadata column, adding the value when it is new. The value is taken
 * as it reads back from the file (JSON.stringify wrote it), so a write applied in memory and a fresh read agree.
 */
function codeOf(column: MetaColumn, value: unknown): number {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 0;
  if (value !== null && typeof value === 'object') {
    const text = JSON.stringify(value);
    let code = column.json.get(text);
    if (code === undefined) {
      column.json.set(text, (code = column.values.length));
      column.values.push(JSON.parse(text));
    }
    return code;
  }
  const plain = typeof value === 'number' && !Number.isFinite(value) ? null : value;
  let code = column.plain.get(plain);
  if (code === undefined) {
    column.plain.set(plain, (code = column.values.length));
    column.values.push(plain);
  }
  return code;
}

export class LocalVectorClient {
  private memory = new Map<string, MemoryIndex>();
  private meta = new Map<string, MetaIndex>();
  private checked = new Set<string>();
  /** Collections whose table has the vector_error column (canRefuse). */
  private refusable = new Map<string, boolean>();
  private reads = new Map<string, Reads>();
  /** Words found in many passages, with how many: counting those is what costs (see keywordTerms). */
  private commonTerms = new Map<string, { total: number; version: number; docs: Map<string, number>; count: StatementSync }>();

  constructor(private readonly db: DatabaseSync) {
    // Several processes can write here (the server, a manual `drive reindex`, stdio sessions). Without a timeout
    // the second writer fails at once with "database is locked".
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000');
    db.exec('CREATE TABLE IF NOT EXISTS vec_collections (name TEXT PRIMARY KEY, dim INTEGER NOT NULL)');
    // Which model made the stored vectors. Added later, so a file from an older version gets the column here.
    const cols = db.prepare('PRAGMA table_info(vec_collections)').all() as Array<{ name: string }>;
    // And what they were made from (index_profile.ts passageMark): the heading before a passage, and a prefix.
    for (const column of ['model', 'passage_form']) {
      if (cols.some((c) => c.name === column)) continue;
      try {
        db.exec(`ALTER TABLE vec_collections ADD COLUMN ${column} TEXT`);
      } catch {
        /* another process added it first */
      }
    }
  }

  /** What was read into memory is no longer what the file holds (the collection was made again or dropped). */
  private forget(name: string): void {
    this.memory.delete(name);
    this.meta.delete(name);
    this.commonTerms.delete(name);
    this.refusable.delete(name);
  }

  /**
   * After a write by this process: bring the memory copies up to date with it instead of reading everything again.
   * A copy that misses a write by another process (data_version moved since it was read) is left as it is: it is
   * read again when it is next needed (load), into the same array when the vectors fit. This connection's own writes
   * do not move data_version.
   */
  private applyWrite(name: string, ops: WriteOp[]): void {
    // A chunk removed or rewritten may make a common word rarer: what was counted is counted again (termDocs).
    if (ops.some((op) => op.kind === 'remove')) this.commonTerms.delete(name);
    if (!this.memory.has(name) && !this.meta.has(name)) return;
    const version = this.dataVersion();
    const vectors = this.memory.get(name);
    if (vectors && vectors.dataVersion === version) {
      for (const op of ops) {
        if (op.kind === 'remove') this.dropVector(vectors, op.rid);
        else if (op.vector) this.putVector(vectors, op.rid, op.id, op.vector);
      }
      // Marked slots still cost a check in every search: squeezed out in place once they are half of them.
      if (vectors.dead > 64 && vectors.dead * 2 > vectors.size) this.compact(vectors, vectors.matrix);
    }
    const meta = this.meta.get(name);
    if (meta && meta.dataVersion === version) {
      for (const op of ops) {
        if (op.kind === 'remove') this.dropMeta(meta, op.rid);
        else if (op.kind === 'add') this.putMeta(meta, op.rid, op.payload);
      }
      // A value no chunk holds any more stays in its column. Read afresh once those pile up.
      const live = meta.slotOf.size;
      if ([...meta.columns.values()].some((column) => column.values.length > 2 * live + 1024)) this.meta.delete(name);
    }
  }

  /** A chunk's vector is gone: its slot is marked, not moved, so no other slot changes. */
  private dropVector(index: MemoryIndex, rid: number): void {
    const slot = index.slotOf.get(rid);
    if (slot === undefined) return;
    index.slotOf.delete(rid);
    index.rows[slot] = -1;
    index.ids[slot] = '';
    index.dead++;
  }

  /** A chunk's vector is new or changed: overwritten in its slot, or written into the spare room at the end. */
  private putVector(index: MemoryIndex, rid: number, id: string, vector: Float32Array): void {
    let slot = index.slotOf.get(rid);
    if (slot === undefined) {
      if (index.size === index.capacity) this.makeRoom(index);
      slot = index.size++;
      index.slotOf.set(rid, slot);
      index.rows[slot] = rid;
    }
    index.ids[slot] = id;
    index.matrix.set(vector, slot * index.dim);
  }

  /**
   * The spare room is used up. When many slots are marked as gone, they are squeezed out in place; otherwise the
   * vectors move to a larger array (GROWTH times the room), dropping the marked slots on the way.
   */
  private makeRoom(index: MemoryIndex): void {
    if (index.dead * 8 >= index.capacity) return this.compact(index, index.matrix);
    const capacity = Math.max(index.size - index.dead + 1, Math.ceil(index.capacity * GROWTH));
    this.compact(index, this.allocate(index.dim, capacity, index.count));
  }

  /** Move the vectors that are still there to the front of `target`, in the same order, and forget the marks. */
  private compact(index: MemoryIndex, target: Float32Array): void {
    const { dim, matrix, rows, ids } = index;
    let to = 0;
    for (let from = 0; from < index.size; from++) {
      const rid = rows[from];
      if (rid < 0) continue;
      if (target !== matrix) target.set(matrix.subarray(from * dim, (from + 1) * dim), to * dim);
      else if (to !== from) matrix.copyWithin(to * dim, from * dim, (from + 1) * dim);
      rows[to] = rid;
      ids[to] = ids[from];
      index.slotOf.set(rid, to);
      to++;
    }
    rows.length = to;
    ids.length = to;
    index.size = to;
    index.dead = 0;
    index.matrix = target;
    index.capacity = target.length / dim;
  }

  /** A new array for `capacity` vectors, counted (see memoryUse). */
  private allocate(dim: number, capacity: number, count: { allocations: number }): Float32Array {
    count.allocations++;
    return new Float32Array(capacity * dim);
  }

  private readsOf(name: string): Reads {
    let r = this.reads.get(name);
    if (!r) this.reads.set(name, (r = { loads: 0, allocations: 0, metadataLoads: 0 }));
    return r;
  }

  /** A chunk is gone from the metadata: its slot is given to the next new chunk. */
  private dropMeta(meta: MetaIndex, rid: number): void {
    const slot = meta.slotOf.get(rid);
    if (slot === undefined) return;
    meta.slotOf.delete(rid);
    for (const column of meta.columns.values()) column.codes[slot] = 0;
    meta.free.push(slot);
  }

  /** A new chunk's fields, in a slot given back by a removed chunk or a new one at the end. */
  private putMeta(meta: MetaIndex, rid: number, payload: Payload | null): void {
    let slot = meta.slotOf.get(rid) ?? meta.free.pop();
    if (slot === undefined) {
      if (meta.size === meta.capacity) {
        meta.capacity = Math.ceil(meta.capacity * GROWTH) + 64;
        for (const column of meta.columns.values()) {
          const codes = new Int32Array(meta.capacity);
          codes.set(column.codes);
          column.codes = codes;
        }
      }
      slot = meta.size++;
    }
    meta.slotOf.set(rid, slot);
    for (const [key, column] of meta.columns) column.codes[slot] = codeOf(column, payload?.[key]);
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB, vector_error TEXT)`);
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
    this.refusable.delete(name);
    this.canRefuse(name);
  }

  /**
   * Whether the table can set aside chunks the embedding endpoint refused (the vector_error column: why a chunk has
   * no vector). A file from an older version gets the column on first use. When that cannot be done now (the file is
   * read-only, or another process is writing), everything works as it did without it, and it is tried again on a
   * later call.
   */
  private canRefuse(name: string): boolean {
    if (this.refusable.get(name)) return true;
    const table = tableOf(name);
    const has = () => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === 'vector_error');
    if (!has()) this.tryChange(`ALTER TABLE ${table} ADD COLUMN vector_error TEXT`);
    const ok = has();
    // Counting the refused chunks reads this small index. Without it the count reads the table, which still works.
    if (ok) this.tryChange(`CREATE INDEX IF NOT EXISTS ${table}_refused ON ${table} (file_id) WHERE vector_error IS NOT NULL`);
    this.refusable.set(name, ok);
    return ok;
  }

  /**
   * A change to the file's layout that waits for nobody: it gives up at once when the file is read-only or another
   * process is writing. (With the usual ten-second wait, the first search of a new version waited that long behind
   * an older server's reindex, and then failed.)
   */
  private tryChange(sql: string): void {
    this.db.exec('PRAGMA busy_timeout = 0');
    try {
      this.db.exec(sql);
    } catch {
      /* read-only or busy: tried again later */
    } finally {
      this.db.exec('PRAGMA busy_timeout = 10000');
    }
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
      // One chunk at a time: reading them all first held every chunk's text in memory at once.
      const rows = this.db.prepare(`SELECT rowid AS rid, payload FROM ${table}`).iterate() as Iterable<{ rid: number; payload: string }>;
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
    this.db.exec(`DROP TABLE IF EXISTS temp.${vocabOf(name)}`);
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
    const ops: WriteOp[] = [];
    this.db.exec('BEGIN');
    try {
      for (const p of body.points) {
        if (p.vector && p.vector.length !== dim) {
          throw new Error(`[index] vector size ${p.vector.length} does not match collection '${name}' (${dim})`);
        }
        const id = String(p.id);
        const old = find.get(id) as { rid: number } | undefined;
        if (old) {
          this.removeRows(name, [old.rid]);
          ops.push({ kind: 'remove', rid: old.rid });
        }
        const fileId = typeof p.payload?.file_id === 'string' ? p.payload.file_id : null;
        const vector = p.vector ? normalized(p.vector) : null;
        const info = ins.run(id, fileId, JSON.stringify(p.payload ?? null), vector ? blobOf(vector) : null);
        const rid = Number(info.lastInsertRowid);
        insFts.run(rid, tokenText(searchableText(p.payload)));
        ops.push({ kind: 'add', rid, id, vector, payload: p.payload ?? null });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.applyWrite(name, ops);
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
        const clauses = mustClauses(body.filter);
        const rows = this.db.prepare(`SELECT rowid AS rid, payload FROM ${table}`).iterate() as Iterable<{ rid: number; payload: string }>;
        for (const r of rows) if (matchesFilter(JSON.parse(r.payload) as Payload | null, clauses)) rowids.push(r.rid);
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
    this.applyWrite(name, rowids.map((rid) => ({ kind: 'remove', rid })));
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
    const clauses = mustClauses(body.filter);
    const oneFile = clauses.length === 1 && clauses[0].key === 'file_id' && typeof clauses[0].value === 'string';
    // When only a few fields are asked for and nothing is filtered, the database picks them out: the chunk text is
    // most of every row, and reading it into the server only to drop it made paging through an index slow.
    // The same for one document: the database filters it by its file_id column, so the payload is not needed for that.
    const keys = Array.isArray(body.with_payload) && (!body.filter || oneFile) && body.with_payload.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) ? body.with_payload : null;
    const column = keys ? `json_object(${keys.map((k) => `'${k}', json_extract(payload, '$.${k}')`).join(', ')}) AS payload` : 'payload';
    const rows = (
      oneFile
        ? this.db.prepare(`SELECT rowid AS rid, id, ${column} FROM ${tableOf(name)} WHERE file_id = ? AND rowid >= ? ORDER BY rowid`).iterate(clauses[0].value as string, from)
        : this.db.prepare(`SELECT rowid AS rid, id, ${column} FROM ${tableOf(name)} WHERE rowid >= ? ORDER BY rowid`).iterate(from)
    ) as Iterable<{ rid: number; id: string; payload: string }>;
    const points: QdrantPoint[] = [];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Payload | null;
      if (!oneFile && !matchesFilter(payload, clauses)) continue;
      if (points.length === limit) return { points, next_page_offset: r.rid }; // the paging cursor is the row number, not a point id
      points.push({ id: Number(r.id), payload: pickPayload(payload, body.with_payload ?? true) });
    }
    return { points, next_page_offset: null };
  }

  /**
   * Every vector in one array, for search. Only the vectors: a chunk's text and metadata stay in the file and are
   * read for the few chunks a search returns. (Loading them too held the whole index in memory a second time.)
   * Read once; after that this process's writes are applied to it (applyWrite), and it is read again only when
   * another process wrote.
   */
  private load(name: string): MemoryIndex {
    const version = this.dataVersion();
    let cached = this.memory.get(name);
    if (cached && cached.dataVersion === version) return cached;
    const dim = this.requireDim(name);
    const table = tableOf(name);
    const count = this.readsOf(name);
    // One snapshot for the count and the rows, so exactly what is counted is read.
    this.db.exec('BEGIN');
    let index: MemoryIndex;
    try {
      const n = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE vector IS NOT NULL`).get() as { n: number }).n);
      // Read again after another process wrote: the array held already is filled again when the vectors still fit,
      // rather than left to the garbage collector while a new one is made.
      let matrix: Float32Array;
      if (cached && cached.dim === dim && cached.capacity >= n) matrix = cached.matrix;
      else {
        // Grown by another process: by half again at least, as for this process's own writes (makeRoom). Room for
        // only a sixteenth more made a new array at nearly every batch while another process filled in vectors.
        const capacity = Math.max(n + headroom(n), cached && cached.dim === dim ? Math.ceil(cached.capacity * GROWTH) : 0);
        this.memory.delete(name);
        cached = undefined;
        matrix = this.allocate(dim, capacity, count);
      }
      const bytes = new Uint8Array(matrix.buffer, matrix.byteOffset, matrix.byteLength);
      const ids: string[] = new Array(n);
      const rows: number[] = new Array(n);
      const slotOf = new Map<number, number>();
      let i = 0;
      const stored = this.db.prepare(`SELECT rowid AS rid, id, vector FROM ${table} WHERE vector IS NOT NULL ORDER BY rowid`).iterate() as Iterable<{
        rid: number;
        id: string;
        vector: Uint8Array;
      }>;
      for (const r of stored) {
        if (i === n) break;
        // Copied as bytes: a row's buffer is not guaranteed to start where a Float32Array could view it.
        const length = Math.min(r.vector.byteLength, dim * 4);
        bytes.set(r.vector.subarray(0, length), i * dim * 4);
        if (length < dim * 4) bytes.fill(0, i * dim * 4 + length, (i + 1) * dim * 4);
        rows[i] = Number(r.rid);
        ids[i] = r.id;
        slotOf.set(rows[i], i++);
      }
      rows.length = i;
      ids.length = i;
      index = { dim, matrix, capacity: matrix.length / dim, size: i, ids, rows, slotOf, dead: 0, dataVersion: version, count };
      count.loads++;
    } finally {
      this.db.exec('COMMIT');
    }
    this.memory.set(name, index);
    return index;
  }

  /**
   * The metadata fields filters look at (META_FIELDS, and any other a filter asks for), for every chunk. Read the
   * first time a filter or fieldValues needs them; after that this process's writes are applied to them
   * (applyWrite). Read again when another process wrote or a field not held yet is asked for. A search without a
   * filter never needs them.
   */
  private metadata(name: string, keys: string[]): MetaIndex {
    const version = this.dataVersion();
    const cached = this.meta.get(name);
    if (cached && cached.dataVersion === version && keys.every((k) => cached.columns.has(k))) return cached;
    const fields = [...new Set([...META_FIELDS, ...(cached ? cached.columns.keys() : []), ...keys])];
    this.meta.delete(name);
    const table = tableOf(name);
    this.db.exec('BEGIN');
    let meta: MetaIndex;
    try {
      const n = Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      const capacity = n + headroom(n);
      const columns = new Map<string, MetaColumn>(fields.map((f) => [f, newColumn(capacity)]));
      // The chunk text, most of every row, is left in the database. Each payload is read one at a time and only its
      // fields' numbers are kept.
      const stored = this.db.prepare(`SELECT rowid AS rid, json_remove(payload, '$.content') AS payload FROM ${table}`).iterate() as Iterable<{
        rid: number;
        payload: string | null;
      }>;
      const slotOf = new Map<number, number>();
      let slot = 0;
      for (const r of stored) {
        if (slot === n) break;
        const payload = r.payload ? (JSON.parse(r.payload) as Payload | null) : null;
        slotOf.set(Number(r.rid), slot);
        for (const [key, column] of columns) column.codes[slot] = codeOf(column, payload?.[key]);
        slot++;
      }
      meta = { slotOf, free: [], size: slot, capacity, columns, dataVersion: version };
      this.readsOf(name).metadataLoads++;
    } finally {
      this.db.exec('COMMIT');
    }
    this.meta.set(name, meta);
    return meta;
  }

  /**
   * A `must` filter as a test on a row number, against the metadata in memory. Which values of a field pass is
   * worked out once per search, so each chunk costs a lookup per clause.
   */
  private rowFilter(name: string, clauses: Clause[]): (rid: number) => boolean {
    const meta = this.metadata(name, clauses.map((c) => c.key));
    const checks = clauses.map(({ key, value }) => {
      const column = meta.columns.get(key)!;
      const pass = new Uint8Array(column.values.length);
      for (let v = 0; v < column.values.length; v++) pass[v] = matches(column.values[v], value) ? 1 : 0;
      return { codes: column.codes, pass };
    });
    return (rid) => {
      const slot = meta.slotOf.get(rid);
      // A chunk the metadata does not know is a chunk without those fields (value 0).
      for (const c of checks) if (!c.pass[slot === undefined ? 0 : c.codes[slot]]) return false;
      return true;
    };
  }

  /** Vector search. Only chunks that have a vector take part. */
  async search(
    name: string,
    body: { vector: number[]; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[]; score_threshold?: number },
  ): Promise<ScoredPoint[]> {
    const clauses = mustClauses(body.filter);
    const index = this.load(name);
    const { dim, ids, rows, matrix, size } = index;
    if (body.vector.length !== dim) {
      throw new Error(`[index] query vector size ${body.vector.length} does not match collection '${name}' (${dim})`);
    }
    const q = normalized(body.vector);
    const pass = clauses.length ? this.rowFilter(name, clauses) : null;
    // The best `limit` are kept as they are found (sorted, best first): one pass, and no list of every score to sort.
    // Equal scores are kept in row order, the order a fresh read gives: a vector written later sits in a later slot
    // whatever its row number.
    const k = Math.max(0, Math.min(body.limit, size - index.dead));
    const topScore = new Float64Array(k);
    const topRid = new Float64Array(k);
    const topSlot = new Int32Array(k);
    let kept = 0;
    const floor = body.score_threshold ?? -Infinity;
    for (let i = 0; i < size && k > 0; i++) {
      const rid = rows[i];
      if (rid < 0 || (pass && !pass(rid))) continue;
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
      if (dot < floor || (kept === k && (dot < topScore[k - 1] || (dot === topScore[k - 1] && rid > topRid[k - 1])))) continue;
      let at = kept < k ? kept++ : k - 1;
      while (at > 0 && (topScore[at - 1] < dot || (topScore[at - 1] === dot && topRid[at - 1] > rid))) {
        topScore[at] = topScore[at - 1];
        topRid[at] = topRid[at - 1];
        topSlot[at] = topSlot[at - 1];
        at--;
      }
      topScore[at] = dot;
      topRid[at] = rid;
      topSlot[at] = i;
    }
    const want = body.with_payload ?? false;
    const read = want === false ? null : this.db.prepare(`SELECT payload FROM ${tableOf(name)} WHERE id = ?`);
    const out: ScoredPoint[] = [];
    for (let r = 0; r < kept; r++) {
      const id = ids[topSlot[r]];
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
    const clauses = mustClauses(body.filter);
    const all = queryTerms(body.query);
    // A filtered search looks for every word: which words are rare among the passages the filter lets through is
    // not known, and the one rare in the whole index may not be among them at all.
    const terms = clauses.length ? all : this.keywordTerms(name, body.query);
    const found = this.rankByWords(name, terms, clauses, body);
    // Fewer found than asked for: the words left out could find more, so the whole question is searched, as before.
    if (terms.length < all.length && found.length < body.limit) return this.rankByWords(name, all, clauses, body);
    return found;
  }

  private rankByWords(name: string, terms: string[], clauses: Clause[], body: { limit: number; with_payload?: boolean | string[] }): ScoredPoint[] {
    const match = matchExpression(terms);
    if (!match) return [];
    const table = tableOf(name);
    const fts = ftsOf(name);
    // The ranking is read as row numbers only, and the text is read for the chunks that are returned. (Ranking the
    // chunks together with their text made the database carry every candidate's text through its sort.)
    // A filter is applied after ranking, down a generous stretch of it, so a filter that few chunks pass still
    // finds them; the stretch is bounded so a filter nothing passes does not walk a huge index for every query.
    const ranked = this.db
      .prepare(`SELECT rowid AS rid, bm25(${fts}) AS rank FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT ?`)
      .all(match, clauses.length ? KEYWORD_FILTER_SCAN : body.limit) as Array<{ rid: number; rank: number }>;
    const pass = clauses.length ? this.rowFilter(name, clauses) : null;
    const read = this.db.prepare(`SELECT id, payload FROM ${table} WHERE rowid = ?`);
    const out: ScoredPoint[] = [];
    for (const r of ranked) {
      if (pass && !pass(Number(r.rid))) continue;
      const row = read.get(r.rid) as { id: string; payload: string } | undefined;
      if (!row) continue;
      out.push({ id: Number(row.id), score: -r.rank, payload: pickPayload(JSON.parse(row.payload) as Payload | null, body.with_payload ?? true) }); // bm25() is smaller for better matches
      if (out.length === body.limit) break;
    }
    return out;
  }

  /**
   * The words an unfiltered keyword search looks for first. In a small index, all of them. In a large one a word
   * found in more than a fifth of the passages is dropped while rarer words remain, and the rarest KEYWORD_MAX_TERMS
   * are kept. A common word matches nearly every passage, and BM25 then ranks each one: a long Korean question (every
   * pair of characters is a word) took 400 ms at 70,000 passages and blocked the server meanwhile. It adds little to
   * the ranking, which weighs a word by how rare it is. A word the index does not hold is kept (it costs nothing to
   * look for), and when the words kept find fewer passages than asked for, keywordSearch looks for all of them.
   */
  keywordTerms(name: string, question: string): string[] {
    const terms = queryTerms(question);
    if (terms.length <= 1) return terms;
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM ${tableOf(name)}`).get() as { n: number }).n);
    if (total < KEYWORD_TRIM_FROM) return terms;
    const common = total * KEYWORD_COMMON_SHARE;
    const counted: Array<{ term: string; at: number; docs: number }> = [];
    for (const [at, term] of terms.entries()) {
      const docs = this.termDocs(name, term, total, common);
      if (docs === null) return terms; // the word list cannot be read here: nothing is dropped
      counted.push({ term, at, docs });
    }
    const unknown = counted.filter((t) => t.docs === 0);
    const known = counted.filter((t) => t.docs > 0);
    const rare = known.filter((t) => t.docs <= common);
    const kept = [...unknown, ...(rare.length ? rare : known).sort((a, b) => a.docs - b.docs || a.at - b.at).slice(0, KEYWORD_MAX_TERMS)];
    return kept.sort((a, b) => a.at - b.at).map((t) => t.term);
  }

  /**
   * How many passages hold a word, from the keyword index's own word list (fts5vocab, made for this connection).
   * The index splits a word as FTS5's tokenizer does (ftsPieces), so a word of several pieces is counted by its rarest
   * piece: no passage can hold it more often. Null when the word list cannot be made (a read-only connection).
   */
  private termDocs(name: string, term: string, total: number, common: number): number | null {
    let known = this.commonTerms.get(name);
    // What was remembered is dropped when another process wrote (data_version), and once the index has grown or
    // shrunk by a tenth. This process's removals drop it too (applyWrite).
    const version = this.dataVersion();
    if (!known || known.version !== version || Math.abs(known.total - total) * 10 > total) {
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${vocabOf(name)} USING fts5vocab(main, ${ftsOf(name)}, 'row')`);
        known = { total, version, docs: new Map(), count: this.db.prepare(`SELECT doc FROM temp.${vocabOf(name)} WHERE term = ?`) };
      } catch {
        return null;
      }
      this.commonTerms.set(name, known);
    }
    let fewest = Infinity;
    for (const piece of ftsPieces(term)) {
      let docs = known.docs.get(piece);
      if (docs === undefined) {
        docs = Number((known.count.get(piece) as { doc: number } | undefined)?.doc ?? 0);
        // Counting a common word reads its whole list of passages (about a millisecond at 70,000), so those are
        // remembered: a common word stays common while a few documents are added. A rarer word is counted every
        // time, which is quick, so a word that a new document brings is never taken for absent.
        if (docs > common) {
          if (known.docs.size >= 10_000) known.docs.clear();
          known.docs.set(piece, docs);
        }
      }
      fewest = Math.min(fewest, docs);
    }
    return fewest === Infinity ? 0 : fewest;
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
  async documentTimes(name: string, prefix = ''): Promise<Map<string, { modified: string; cut: string | null }>> {
    const out = new Map<string, { modified: string; cut: string | null }>();
    if (this.dimOf(name) === undefined) return out;
    this.requireDim(name);
    const table = tableOf(name);
    const rows = this.db
      .prepare(
        `SELECT file_id, json_extract(payload, '$.modified_time') AS modified, json_extract(payload, '$.cut') AS cut FROM ${table} ` +
          `WHERE rowid IN (SELECT min(rowid) FROM ${table} WHERE file_id >= ? AND file_id < ? GROUP BY file_id)`,
      )
      .iterate(prefix, `${prefix}\u{10FFFF}`) as Iterable<{ file_id: string | null; modified: string | null; cut: string | null }>;
    for (const r of rows) if (r.file_id) out.set(r.file_id, { modified: r.modified ?? '', cut: r.cut ?? null });
    return out;
  }

  /**
   * How many documents were cut another way than `cut` (index_profile.ts cutMark). A document indexed before the
   * way was kept with it counts as `legacy`. Read from each document's first passage.
   */
  async documentsCutOtherwise(name: string, cut: string, legacy: string): Promise<number> {
    if (this.dimOf(name) === undefined) return 0;
    this.requireDim(name);
    const table = tableOf(name);
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM ${table} WHERE rowid IN (SELECT min(rowid) FROM ${table} WHERE file_id IS NOT NULL GROUP BY file_id) ` +
          `AND coalesce(json_extract(payload, '$.cut'), ?) <> ?`,
      )
      .get(legacy, cut) as { n: number };
    return row.n;
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
    const meta = this.metadata(name, [key, 'file_id']);
    const column = meta.columns.get(key)!;
    const files = meta.columns.get('file_id')!;
    const docs = new Map<string, Set<string>>();
    for (const slot of meta.slotOf.values()) {
      const raw = column.values[column.codes[slot]];
      const fileId = files.values[files.codes[slot]];
      const file = typeof fileId === 'string' ? fileId : '';
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
  async embeddingState(name: string): Promise<{ dim: number; model: string | null; form: string | null; vectors: number } | null> {
    const row = this.db.prepare('SELECT dim, model, passage_form AS form FROM vec_collections WHERE name = ?').get(name) as { dim: number; model: string | null; form: string | null } | undefined;
    if (!row) return null;
    this.requireDim(name);
    // Counted, not loaded: this is asked on every search and every status read, and loading every vector to count
    // them cost hundreds of megabytes each time the index had changed.
    const { chunks, missing } = this.counts(name);
    return { dim: row.dim, model: row.model ?? null, form: row.form ?? null, vectors: chunks - missing };
  }

  /**
   * Change the collection's vector size. Only while no chunk has a vector: an index built for keyword search was
   * created with whatever size was the default then, and takes the size of the model that is added later.
   */
  async adoptDimension(name: string, dim: number): Promise<void> {
    const state = await this.embeddingState(name);
    if (!state) return;
    if (state.vectors > 0) throw new Error(`[index] collection '${name}' holds vectors; clear them before changing the size`);
    this.db.prepare('UPDATE vec_collections SET dim = ?, model = NULL, passage_form = NULL WHERE name = ?').run(dim, name);
    this.memory.delete(name); // no vector to keep, and maybe another size; the metadata is unchanged
  }

  /**
   * Remember which model made the vectors and from what form of the passage, so a later change of either is
   * noticed instead of mixing two kinds of vector.
   */
  async noteModel(name: string, model: string, form: string): Promise<void> {
    this.db.prepare('UPDATE vec_collections SET model = ?, passage_form = ? WHERE name = ? AND (model IS NOT ? OR passage_form IS NOT ?)').run(model, form, name, model, form);
  }

  /**
   * Drop every vector and set the size for the next model. The chunk text and the keyword index stay, so vectors
   * can be made again from what is stored. Returns how many chunks lost their vector.
   */
  async clearVectors(name: string, dim: number): Promise<number> {
    this.requireDim(name);
    const r = this.db.prepare(`UPDATE ${tableOf(name)} SET vector = NULL WHERE vector IS NOT NULL`).run();
    // The next model gets a try at the chunks this one refused.
    if (this.canRefuse(name)) this.db.prepare(`UPDATE ${tableOf(name)} SET vector_error = NULL WHERE vector_error IS NOT NULL`).run();
    this.db.prepare('UPDATE vec_collections SET dim = ?, model = NULL, passage_form = NULL WHERE name = ?').run(dim, name);
    this.memory.delete(name); // no vector left, and maybe another size; the metadata is unchanged
    return Number(r.changes);
  }

  /**
   * Chunks stored without a vector (indexed before an embedding model was configured), except those the endpoint
   * refused in the last REFUSAL_RETRY_MS (refuseVectors).
   */
  async missingVectors(name: string, limit: number): Promise<Array<{ id: number; payload: Payload | null }>> {
    this.requireDim(name);
    // Through the index of chunks without a vector: the cost is the batch, however many chunks are already done.
    // A refusal starts with when it was made (refuseVectors), so an older one compares as smaller than the cutoff.
    const refusable = this.canRefuse(name);
    const rows = (
      refusable
        ? this.db
            .prepare(`SELECT id, payload FROM ${tableOf(name)} WHERE vector IS NULL AND (vector_error IS NULL OR vector_error < ?) LIMIT ?`)
            .all(new Date(Date.now() - REFUSAL_RETRY_MS).toISOString(), limit)
        : this.db.prepare(`SELECT id, payload FROM ${tableOf(name)} WHERE vector IS NULL LIMIT ?`).all(limit)
    ) as Array<{ id: string; payload: string }>;
    return rows.map((r) => ({ id: Number(r.id), payload: JSON.parse(r.payload) as Payload | null }));
  }

  /** Add vectors to chunks that are already stored. The chunk text and the keyword index are untouched. */
  async setVectors(name: string, vectors: Array<{ id: PointId; vector: number[] }>): Promise<void> {
    const dim = this.requireDim(name);
    const clear = this.canRefuse(name) ? ', vector_error = NULL' : '';
    const stmt = this.db.prepare(`UPDATE ${tableOf(name)} SET vector = ?${clear} WHERE id = ? RETURNING rowid AS rid`);
    const ops: WriteOp[] = [];
    this.db.exec('BEGIN');
    try {
      for (const v of vectors) {
        if (v.vector.length !== dim) throw new Error(`[index] vector size ${v.vector.length} does not match collection '${name}' (${dim})`);
        const id = String(v.id);
        const vector = normalized(v.vector);
        const row = stmt.get(blobOf(vector), id) as { rid: number } | undefined;
        if (row) ops.push({ kind: 'vector', rid: Number(row.rid), id, vector });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.applyWrite(name, ops);
  }

  /**
   * Set aside chunks the embedding endpoint refused (too long for the model, say), with when and why. missingVectors
   * does not offer them for REFUSAL_RETRY_MS, so they do not hold up the others; they stay searchable by keywords.
   * A new text for the chunk (its document changed), a new model (clearVectors), or the end of that time gives them
   * another try. Returns false when the file cannot hold the mark now (canRefuse): they are then offered again.
   */
  async refuseVectors(name: string, refused: Array<{ id: PointId; reason: string }>): Promise<boolean> {
    this.requireDim(name);
    if (!this.canRefuse(name)) return false;
    const stmt = this.db.prepare(`UPDATE ${tableOf(name)} SET vector_error = ? WHERE id = ? AND vector IS NULL`);
    const when = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      for (const r of refused) stmt.run(`${when} ${r.reason || 'refused'}`.slice(0, 500), String(r.id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return true;
  }

  /** How many chunks have no vector because the embedding endpoint refused them (refuseVectors). */
  async refusedVectors(name: string): Promise<number> {
    if (this.dimOf(name) === undefined) return 0;
    this.requireDim(name);
    if (!this.canRefuse(name)) return 0;
    return Number((this.db.prepare(`SELECT count(*) AS n FROM ${tableOf(name)} WHERE vector_error IS NOT NULL`).get() as { n: number }).n);
  }

  /**
   * What the memory copies of a collection hold: the room for vectors and how much of it is used, and how often each
   * copy was read from the file and how many vector arrays were made. For tests and diagnostics.
   */
  memoryUse(name: string): { capacity: number; slots: number; vectors: number; chunks: number | null; loads: number; allocations: number; metadataLoads: number } {
    const index = this.memory.get(name);
    const meta = this.meta.get(name);
    const reads = this.reads.get(name) ?? { loads: 0, allocations: 0, metadataLoads: 0 };
    return {
      capacity: index?.capacity ?? 0,
      slots: index?.size ?? 0,
      vectors: index ? index.size - index.dead : 0,
      chunks: meta ? meta.slotOf.size : null,
      ...reads,
    };
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
