/**
 * What a SQL connection can do, whichever database is behind it.
 *
 * Three rules every adapter keeps:
 *   1. Parameter values are bound by the database driver. They are never written into the SQL text.
 *   2. A read-only query is refused by the database itself if it tries to write (a read-only transaction or a
 *      read-only connection), not only by looking at the text.
 *   3. A query has a row limit and a time limit, so one question cannot fetch a whole table or hold the server.
 */
import type { Table } from './format.js';
import type { ParsedSql } from './sql.js';

export interface SqlQuery {
  sql: ParsedSql;
  /** Parameter values by name. A name without a value is sent as NULL. */
  values: Record<string, unknown>;
  readOnly: boolean;
  maxRows: number;
  timeoutMs: number;
  /** The SQL text was written by the caller (the explore tool), not by the administrator. */
  untrusted?: boolean;
}

export interface TableInfo {
  /** "orders", or "schema.table" outside the default schema. */
  name: string;
  kind: 'table' | 'view';
  columns: Array<{ name: string; type: string }>;
  /** Approximate row count, when the database knows one cheaply. */
  rows?: number;
}

export interface SqlAdapter {
  /** Connect and say what answered, e.g. "PostgreSQL 16.4". Throws with the reason when it cannot. */
  ping(): Promise<string>;
  query(q: SqlQuery): Promise<Table>;
  /** Compile the query without running it: unknown tables and columns, syntax errors and untyped parameters throw. */
  validate(sql: ParsedSql): Promise<void>;
  /** Tables and views this connection can read, with their columns. */
  tables(): Promise<TableInfo[]>;
  close(): Promise<void>;
}
