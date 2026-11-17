/**
 * SQLite connection for declared tools.
 *
 * Node's SQLite runs a query on the calling thread until it finishes. On the server's own thread a slow query would
 * stop every other request, and it could not be ended: the time is spent inside SQLite, where neither a timer nor
 * terminating a worker thread reaches. Each query therefore runs in a short-lived child process (about 25 ms to
 * start). When the time limit passes the process is killed, and the server never waits.
 *
 * What keeps a read-only query from doing anything but read, all of it decided inside the child process:
 *   1. The file is opened read-only, so SQLite refuses to change it.
 *   2. SQLite compiles the first statement of the text and nothing after it.
 *   3. That compiled statement must return rows and must start with SELECT, WITH or VALUES. The check is made on
 *      the statement SQLite compiled (`sourceSQL`), not on the text as this server read it: the two can disagree
 *      about where a comment ends, and a statement such as VACUUM INTO 'file' writes a new file even through a
 *      read-only connection.
 *
 * At most a few queries run at once, a waiting line that grows too long is refused, and the answer is cut in the
 * child, so neither processes nor memory pile up.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createLimiter } from '../core/concurrency.js';
import { appRoot } from '../core/paths.js';
import { ToolError } from '../plugin/define.js';
import type { SqlAdapter, SqlQuery, TableInfo } from './adapter.js';
import { MAX_CELL_CHARS, type Table } from './format.js';
import type { ParsedSql } from './sql.js';

// Plain JavaScript on purpose: run with `node -e`, it is the same from source (tsx) and from the build.
// The job arrives on stdin and the answer leaves on stdout, both as JSON.
const CHILD = `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let answer;
  try {
    const w = JSON.parse(raw);
    const { DatabaseSync } = require('node:sqlite');
    const cell = (v) => {
      if (v instanceof Uint8Array) return '[binary, ' + v.length + ' bytes]';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'string' && v.length > w.maxCell) return v.slice(0, w.maxCell) + '… [' + (v.length - w.maxCell) + ' more characters]';
      return v;
    };
    // The start of a statement the way SQLite reads it: whitespace, "--" comments and slash-star comments (which
    // do not nest) are skipped.
    const NEWLINE = String.fromCharCode(10);
    const firstWord = (s) => {
      let i = 0;
      for (;;) {
        while (i < s.length && s.charCodeAt(i) <= 32) i++;
        if (s.startsWith('--', i)) { const e = s.indexOf(NEWLINE, i); i = e === -1 ? s.length : e + 1; continue; }
        if (s.startsWith('/*', i)) { const e = s.indexOf('*/', i + 2); i = e === -1 ? s.length : e + 2; continue; }
        break;
      }
      let j = i;
      while (j < s.length && ((s.charCodeAt(j) | 32) >= 97 && (s.charCodeAt(j) | 32) <= 122)) j++;
      return s.slice(i, j).toLowerCase();
    };
    const db = new DatabaseSync(w.path, { readOnly: w.readOnly });
    let out;
    if (w.mode === 'ping') {
      out = { version: db.prepare('select sqlite_version() as v').get().v };
    } else if (w.mode === 'tables') {
      const list = db.prepare("select name, type from sqlite_schema where type in ('table', 'view') and name not like 'sqlite_%' order by name").all();
      out = list.map((t) => ({
        name: t.name,
        kind: t.type === 'view' ? 'view' : 'table',
        columns: db.prepare('select name, type from pragma_table_info(?)').all(t.name).map((c) => ({ name: c.name, type: c.type || 'any' })),
      }));
    } else {
      const stmt = db.prepare(w.sql);
      const columns = stmt.columns().map((c) => c.name);
      if (w.mode === 'validate') {
        out = { ok: true };
      } else {
        if (w.readOnly) {
          // Judge what SQLite compiled, not the text that was sent.
          const word = firstWord(String(stmt.sourceSQL || w.sql));
          if (columns.length === 0 || (word !== 'select' && word !== 'with' && word !== 'values')) throw new Error('KMCP_NOT_A_READ');
        }
        if (columns.length > 0) {
          // A statement that returns rows: stop reading one row past the limit.
          const arrays = typeof stmt.setReturnArrays === 'function';
          if (arrays) stmt.setReturnArrays(true);
          const rows = [];
          let truncated = false;
          for (const row of stmt.iterate(w.params)) {
            if (rows.length >= w.maxRows) { truncated = true; break; }
            rows.push((arrays ? row : columns.map((c) => row[c])).map(cell));
          }
          out = { columns, rows, truncated };
        } else {
          const r = stmt.run(w.params);
          out = { columns: [], rows: [], truncated: false, changes: Number(r.changes) };
        }
      }
    }
    answer = { ok: out };
  } catch (e) {
    answer = { error: e && e.message ? String(e.message) : String(e) };
  }
  process.stdout.write(JSON.stringify(answer), () => process.exit(0));
});
`;

type Job =
  | { mode: 'ping' | 'tables' }
  | { mode: 'validate'; sql: string }
  | { mode: 'query'; sql: string; params: Record<string, unknown>; maxRows: number };

/** The answer may not grow without bound either. Cells are cut in the child, so this is far above a real answer. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
/** Queries running at once, over all SQLite connections of this server, and how many may wait for a turn. */
const MAX_RUNNING = 4;
const MAX_WAITING = 32;
const turn = createLimiter(MAX_RUNNING);
let waiting = 0;

export function sqliteAdapter(opts: { name: string; path: string }): SqlAdapter {
  const file = isAbsolute(opts.path) ? opts.path : resolve(appRoot(), opts.path);

  const explain = (message: string, readOnly: boolean): string => {
    if (message === 'KMCP_NOT_A_READ') return 'only a single SELECT (or WITH … SELECT) can be run here';
    if (readOnly && /readonly database/i.test(message)) return 'this tool only reads: the query tried to change data and the database refused it';
    return `the database answered: ${message}`;
  };

  function run<T>(job: Job, readOnly: boolean, timeoutMs: number): Promise<T> {
    // Opening a missing file for writing would create an empty database and then fail on the first table.
    if (!existsSync(file)) return Promise.reject(new ToolError(`the database file of "${opts.name}" does not exist: ${file}`));
    if (waiting >= MAX_WAITING) return Promise.reject(new ToolError('too many queries are waiting on this server; try again in a moment'));
    waiting++;
    return turn(() => {
      waiting--;
      return spawnQuery<T>(job, readOnly, timeoutMs);
    });
  }

  function spawnQuery<T>(job: Job, readOnly: boolean, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      // An empty environment: the child needs nothing from it, and the server's secrets stay out of it.
      const child = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=256', '-e', CHILD], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: ToolError | null = null;
      let settled = false;
      const timer = setTimeout(() => stop(new ToolError(`the query took longer than ${timeoutMs / 1000}s and was stopped; narrow it down`)), timeoutMs);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      function stop(why: ToolError) {
        failure ??= why;
        child.kill('SIGKILL');
      }
      // First of all: when the process cannot be started (no file descriptors left) there are no stdio streams and
      // no 'close' event, only this. Without the listener the 'error' event would end the server.
      child.on('error', (e) => settle(() => reject(failure ?? new ToolError(`the query could not be started: ${e.message}`))));
      child.stdout?.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) stop(new ToolError('the answer was too large to read; select fewer or smaller columns'));
        else chunks.push(c);
      });
      child.stdin?.on('error', () => {}); // the child may be gone before the job is written
      child.on('close', () =>
        settle(() => {
          if (failure) return reject(failure);
          let answer: { ok?: T; error?: string };
          try {
            answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new ToolError('the query stopped unexpectedly (it may have run out of memory)'));
          }
          if (answer.error !== undefined) reject(new ToolError(explain(answer.error, readOnly)));
          else resolvePromise(answer.ok as T);
        }),
      );
      child.stdin?.end(JSON.stringify({ ...job, path: file, readOnly, maxCell: MAX_CELL_CHARS }));
    });
  }

  return {
    async ping() {
      const r = await run<{ version: string }>({ mode: 'ping' }, true, 10_000);
      return `SQLite ${r.version}`;
    },
    async query(q: SqlQuery): Promise<Table> {
      // Bound by name. A parameter without a value is NULL; SQLite has no boolean, so true and false are 1 and 0.
      const params: Record<string, unknown> = {};
      for (const n of q.sql.names) {
        const v = q.values[n];
        params[n] = v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;
      }
      return run<Table>({ mode: 'query', sql: q.sql.text, params, maxRows: q.maxRows }, q.readOnly, q.timeoutMs);
    },
    async validate(sql: ParsedSql) {
      await run({ mode: 'validate', sql: sql.text }, true, 10_000);
    },
    async tables(): Promise<TableInfo[]> {
      return run<TableInfo[]>({ mode: 'tables' }, true, 10_000);
    },
    async close() {
      /* nothing stays open between queries */
    },
  };
}
