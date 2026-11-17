/**
 * Postgres connection for declared tools.
 *
 * Every query runs in its own transaction. A read-only tool gets `BEGIN TRANSACTION READ ONLY`, so the database
 * refuses a write however the query is written (a data-changing CTE, a function that inserts), and the transaction
 * is rolled back at the end. `SET LOCAL statement_timeout` stops a slow query on the server; a timer on this side
 * drops the connection if the server does not answer at all. Both settings live inside the transaction, so this
 * works through a transaction pooler too.
 *
 * The row limit of a read-only query is applied by the database (the query is wrapped in `select * from (…) limit n`),
 * so a query over a large table never pulls the table into this process.
 *
 * One statement per query is enforced by the server, not by reading the SQL here. Every query of a tool goes
 * through the extended protocol, where Postgres refuses a second statement ("cannot insert multiple commands into
 * a prepared statement"). The driver's default for a query without parameters is the simple protocol, which runs
 * `a; commit; b` as three statements, and the `commit` would end the read-only transaction. Reading the SQL to
 * count statements cannot be trusted for this: Postgres and any reader can disagree on where a string ends
 * (E'\'' is one string to Postgres).
 *
 * What a query leaves behind is cleaned up too. A session-level advisory lock survives ROLLBACK, so after SQL
 * written by the caller the locks of the session are released inside the transaction. A result is limited in
 * bytes as well as rows, and a connection that dies during a query is an error for that one call, not for the
 * server.
 *
 * `pg` is loaded on first use: a server without a Postgres connection never loads it.
 */
import type { Socket } from 'node:net';
import type { Pool, PoolClient, QueryArrayConfig } from 'pg';
import { ToolError } from '../plugin/define.js';
import type { SqlAdapter, SqlQuery, TableInfo } from './adapter.js';
import type { Table } from './format.js';
import type { ParsedSql } from './sql.js';

/** The most one query may send back. Far above a real answer: rows are limited and long values are cut for the model. */
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const HIDDEN_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

export function postgresAdapter(opts: { name: string; urlEnv: string; pool: number }): SqlAdapter {
  const { name, urlEnv } = opts;
  let pool: Pool | null = null;

  /** Error text without the connection string or its password, whatever produced the message. */
  const scrub = (message: string): string => {
    const url = process.env[urlEnv]?.trim();
    if (!url) return message;
    let out = message.split(url).join(`<${urlEnv}>`);
    try {
      const password = decodeURIComponent(new URL(url).password);
      if (password.length >= 4) out = out.split(password).join('***');
    } catch {
      /* not a URL: nothing more to hide */
    }
    return out;
  };

  const friendly = (e: unknown, timeoutMs: number): ToolError => {
    if (e instanceof ToolError) return e;
    const err = e as { code?: string; message?: string; hint?: string };
    // 25006: a write inside the read-only transaction. The second message is what a data-changing CTE gets when
    // the query is wrapped for the row limit: refused earlier, for the same reason.
    if (err.code === '25006' || /data-modifying statement must be at the top level/.test(err.message ?? '')) {
      return new ToolError('this tool only reads: the query tried to change data and the database refused it');
    }
    if (err.code === '57014') return new ToolError(`the query took longer than ${timeoutMs / 1000}s and was stopped; narrow it down`);
    if (err.code === '42601' && /multiple commands/.test(err.message ?? '')) return new ToolError('only one statement can be run');
    if (/Connection terminated|ECONNRESET|EPIPE|socket hang up/i.test(err.message ?? '')) {
      return new ToolError('the connection to the database was lost while the query ran; try again');
    }
    const text = scrub(err.message ?? String(e));
    return new ToolError(`the database answered: ${text}${err.hint ? ` (hint: ${scrub(err.hint)})` : ''}`);
  };

  const getPool = async (): Promise<Pool> => {
    if (pool) return pool;
    const url = process.env[urlEnv]?.trim();
    if (!url) throw new ToolError(`the connection "${name}" is not set up: the env var ${urlEnv} is empty`);
    const pg = (await import('pg')).default;
    const created = new pg.Pool({ connectionString: url, max: opts.pool, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
    // Without a listener an error on an idle connection (the database restarted) would end the process.
    created.on('error', (e) => console.error(`[${name}] an idle database connection failed: ${scrub(e.message)}`));
    pool = created;
    return created;
  };

  /** Run `work` in a transaction with the time limit. The transaction is rolled back unless `commit` is set. */
  async function inTransaction<T>(
    o: { readOnly: boolean; commit: boolean; timeoutMs: number; untrusted?: boolean },
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await (await getPool()).connect();
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`cannot connect to the database of "${name}": ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
    let released = false;
    let timedOut = false;
    let tooLarge = false;
    let broken = false; // the session could not be left clean: it must not go to the next caller

    // A connection that dies while a query runs (the database restarted, a pooler closed it, the query ended its
    // own session) makes the driver emit 'error' on the client. Without a listener that event ends the process.
    // The query's own promise carries the failure, so the listener has nothing to do.
    const onError = () => {};
    client.on('error', onError);

    // Bytes received for this query. The driver holds a whole result in memory, and a single value larger than a
    // JavaScript string can be makes it throw inside its socket handler, which ends the process. The row limit
    // bounds how many rows come back; this bounds how large they are, by dropping the connection before such a
    // result is complete.
    const stream = (client as unknown as { connection?: { stream?: Socket } }).connection?.stream;
    let received = 0;
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_RESULT_BYTES && !tooLarge) {
        tooLarge = true;
        stream!.destroy();
      }
    };
    stream?.on('data', onData);

    const release = (destroy: boolean) => {
      if (released) return;
      released = true;
      stream?.off('data', onData);
      if (!destroy) client.removeListener('error', onError); // a dropped connection can still emit while it closes
      client.release(destroy);
    };
    const job = (async () => {
      await client.query(o.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.floor(o.timeoutMs)}`);
        let out: T;
        if (o.untrusted) {
          // SQL written by the caller can take a session-level advisory lock (pg_advisory_lock). ROLLBACK does not
          // release such a lock: it would stay on the pooled connection and block an application that uses the same
          // key. It is released here, inside the transaction, so this holds behind a transaction pooler as well.
          // The savepoint makes that possible after a statement that failed.
          await client.query('SAVEPOINT kmcp_query');
          try {
            out = await work(client);
          } catch (e) {
            await client
              .query('ROLLBACK TO SAVEPOINT kmcp_query')
              .then(() => client.query('select pg_advisory_unlock_all()'))
              .catch(() => {
                broken = true;
              });
            throw e;
          }
          await client.query('select pg_advisory_unlock_all()');
        } else {
          out = await work(client);
        }
        await client.query(o.commit ? 'COMMIT' : 'ROLLBACK');
        return out;
      } catch (e) {
        if (!timedOut && !tooLarge) {
          await client.query('ROLLBACK').catch(() => {
            broken = true;
          });
        }
        throw e;
      }
    })();
    job.catch(() => {}); // when the timer wins, this fails later with "connection terminated": already reported
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      // A little after the server-side limit: normally the server stops the query first and says why.
      timer = setTimeout(() => {
        timedOut = true;
        release(true); // drop the connection; the server ends the query when it notices
        reject(new ToolError(`the query took longer than ${o.timeoutMs / 1000}s and was stopped; narrow it down`));
      }, o.timeoutMs + 1500);
    });
    try {
      return await Promise.race([job, deadline]);
    } catch (e) {
      if (tooLarge) throw new ToolError(`the answer was larger than ${MAX_RESULT_BYTES / (1024 * 1024)} MB and was stopped; select fewer rows or shorter values`);
      throw friendly(e, o.timeoutMs);
    } finally {
      clearTimeout(timer);
      release(broken || tooLarge);
    }
  }

  const toDb = (v: unknown): unknown => (v === undefined ? null : v);

  /** Run SQL that came from a tool: always the extended protocol, so the server accepts one statement only. */
  const runOne = (c: PoolClient, text: string, values: unknown[]) =>
    c.query({ text, values, rowMode: 'array', queryMode: 'extended' } as unknown as QueryArrayConfig<unknown[]>);

  return {
    async ping() {
      return inTransaction({ readOnly: true, commit: false, timeoutMs: 10_000 }, async (c) => {
        const r = await c.query('select version() as v');
        return String(r.rows[0]?.v ?? 'PostgreSQL').split(' ').slice(0, 2).join(' ');
      });
    },

    async query(q: SqlQuery): Promise<Table> {
      const values = q.sql.names.map((n) => toDb(q.values[n]));
      return inTransaction({ readOnly: q.readOnly, commit: !q.readOnly, timeoutMs: q.timeoutMs, untrusted: q.untrusted }, async (c) => {
        if (q.readOnly) {
          // The newlines keep a trailing "-- comment" of the query from swallowing the closing parenthesis.
          const text = `select * from (\n${q.sql.positional}\n) as _kmcp_rows limit ${q.maxRows + 1}`;
          const r = await runOne(c, text, values);
          const truncated = r.rows.length > q.maxRows;
          return { columns: r.fields.map((f) => f.name), rows: truncated ? r.rows.slice(0, q.maxRows) : r.rows, truncated };
        }
        const r = await runOne(c, q.sql.positional, values);
        const rows = (r.rows ?? []) as unknown[][];
        return {
          columns: (r.fields ?? []).map((f) => f.name),
          rows: rows.slice(0, q.maxRows),
          truncated: rows.length > q.maxRows,
          changes: r.rowCount ?? 0,
        };
      });
    },

    async validate(sql: ParsedSql) {
      // PREPARE parses and plans the statement without running it. Always in a read-only transaction that is
      // rolled back: checking a tool that writes must not write.
      await inTransaction({ readOnly: true, commit: false, timeoutMs: 10_000 }, async (c) => {
        await runOne(c, `PREPARE _kmcp_check AS\n${sql.positional}`, []);
        await c.query('DEALLOCATE _kmcp_check');
      });
    },

    async tables(): Promise<TableInfo[]> {
      return inTransaction({ readOnly: true, commit: false, timeoutMs: 15_000 }, async (c) => {
        // information_schema lists only what this role may read, which is exactly what a query could use.
        const cols = await c.query(
          `select c.table_schema as s, c.table_name as t, c.column_name as col, c.data_type as type, t.table_type as kind
             from information_schema.columns c
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
            where c.table_schema not in ${HIDDEN_SCHEMAS}
            order by 1, 2, c.ordinal_position
            limit 20000`,
        );
        const counts = new Map<string, number>();
        try {
          await c.query('SAVEPOINT counts');
          const r = await c.query(
            `select n.nspname as s, c.relname as t, c.reltuples::bigint as n
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind in ('r', 'p', 'm') and n.nspname not in ${HIDDEN_SCHEMAS}`,
          );
          for (const row of r.rows) if (Number(row.n) >= 0) counts.set(`${row.s}.${row.t}`, Number(row.n));
        } catch {
          await c.query('ROLLBACK TO SAVEPOINT counts').catch(() => {}); // estimates are a convenience
        }
        const out = new Map<string, TableInfo>();
        for (const row of cols.rows) {
          const key = `${row.s}.${row.t}`;
          let t = out.get(key);
          if (!t) {
            t = { name: row.s === 'public' ? row.t : key, kind: row.kind === 'VIEW' ? 'view' : 'table', columns: [] };
            const n = counts.get(key);
            if (n !== undefined) t.rows = n;
            out.set(key, t);
          }
          t.columns.push({ name: row.col, type: row.type });
        }
        return [...out.values()];
      });
    },

    async close() {
      const p = pool;
      pool = null;
      await p?.end().catch(() => {});
    },
  };
}
