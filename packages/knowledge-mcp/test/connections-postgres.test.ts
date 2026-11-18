/**
 * Declared tools on a Postgres connection, against a real Postgres engine (PGlite, served over TCP so the `pg`
 * driver connects to it like to any server): bound parameters, the row limit applied by the database, read-only
 * enforced by the database, a tool that writes, the time limit, and the checks that compile a query without
 * running it.
 *
 * PGlite serves one connection at a time and does not enforce statement_timeout, so the pool is 1 and the time
 * limit is tested through the timer on this side. The engine runs in a worker thread (test/helpers).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

const seed = `
  create table customers (id serial primary key, email text not null, name text);
  create table orders (id serial primary key, customer_id int references customers(id), total numeric(10,2), status text, meta jsonb, created_at timestamptz);
  insert into customers (email, name) values ('ann@example.com', 'Ann'), ('bob@example.com', 'Bob');
  insert into orders (customer_id, total, status, meta, created_at) values
    (1, 10.50, 'paid', '{"gift": true}', '2026-01-01T00:00:00Z'), (1, 20, 'paid', null, '2026-02-01T00:00:00Z'),
    (1, 5, 'refunded', null, '2026-03-01T00:00:00Z'), (2, 7, 'paid', null, '2026-03-02T00:00:00Z');
  create schema reports;
  create view reports.revenue as select status, sum(total) as total from orders group by status;
`;
const port = await freePort();
// The engine runs in a worker thread: a sleeping query must not hold this thread's timers.
const engine = new Worker(new URL('./helpers/pglite-server.mjs', import.meta.url), { workerData: { seed, port } });
await new Promise<void>((resolve, reject) => {
  engine.once('message', () => resolve());
  engine.once('error', reject);
});

// Every connection goes through this proxy. It forwards bytes unchanged, and cuts the connection from both sides
// when a query holds the marker below: what a database restart or a pooler closing the session looks like.
const DROP = 'kmcp_drop_this_connection';
const proxy = createServer((client) => {
  const upstream = connect(port, '127.0.0.1');
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('data', (d) => {
    if (d.includes(DROP)) end();
    else upstream.write(d);
  });
  upstream.on('data', (d) => client.write(d));
  client.on('error', end).on('close', end);
  upstream.on('error', end).on('close', end);
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = (proxy.address() as AddressInfo).port;

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|EMBEDDING_|KNOWLEDGE_)/.test(k)) delete process.env[k];
const tools = [
  {
    name: 'orders_by_customer',
    connection: 'shop',
    description: 'Orders of one customer, newest first.',
    params: { email: { type: 'string' }, status: { type: 'string', required: false }, limit: { type: 'integer', default: 2, max: 50 } },
    sql: `select o.id, o.total, o.status, o.meta, o.created_at, c.id -- the customer's id too
            from orders o join customers c on c.id = o.customer_id
           where c.email = :email and (:status::text is null or o.status = :status)
           order by o.id desc limit :limit; -- newest first`,
  },
  { name: 'refund_order', connection: 'shop', description: 'Mark an order as refunded.', readOnly: false, params: { id: { type: 'integer' } }, sql: "update orders set status = 'refunded' where id = :id returning id, status" },
  { name: 'sneaky', connection: 'shop', description: 'Looks like a read.', sql: "with gone as (delete from orders returning id) select count(*) from gone" },
  { name: 'nap', connection: 'shop', description: 'Sleeps.', timeoutMs: 300, params: { seconds: { type: 'number' } }, sql: 'select pg_sleep(:seconds)' },
  { name: 'shop_big', connection: 'shop', description: 'Forty rows of one megabyte each.', maxRows: 100, sql: "select repeat('x', 1000000) as c from generate_series(1, 40)" },
  { name: 'never_called', connection: 'down', description: 'x', sql: 'select 1' },
];
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-pg-')),
  SHOP_DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${proxyPort}/postgres`,
  DOWN_DATABASE_URL: 'postgres://app:hunter2-secret@127.0.0.1:1/app',
  MCP_CONFIG_JSON: JSON.stringify({
    connections: {
      shop: { type: 'postgres', urlEnv: 'SHOP_DATABASE_URL', explore: true, maxRows: 3, pool: 1 },
      down: { type: 'postgres', urlEnv: 'DOWN_DATABASE_URL', pool: 1 },
      unset: { type: 'postgres', urlEnv: 'UNSET_DATABASE_URL', explore: true },
    },
    tools,
  }),
});

const { Registry } = await import('../src/plugin/registry.js');
const { readTable } = await import('./helpers/table.js');
const { getConfig } = await import('../src/core/config.js');
const { checkConnection, closeDataConnections } = await import('../src/connections/index.js');
after(async () => {
  await closeDataConnections();
  proxy.close();
  engine.postMessage('stop');
  await new Promise((resolve) => engine.once('exit', resolve));
});

const registry = new Registry([]);
const admin = { ok: true, role: 'admin' as const, email: 'a@x.com' };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await registry.call(name, args, admin);
  return { text: String(r.content[0]?.text ?? ''), isError: r.isError === true };
};
const json = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  assert.equal(r.isError, false, r.text);
  return readTable(r.text);
};
// Rows in `orders`. Also the way a test waits for the engine after a connection was dropped: PGlite serves one
// connection at a time and needs a moment to notice that the last one is gone. A real server does not; the wait is
// for the test engine, and only for "cannot connect".
const count = async (where = 'true') => {
  for (let attempt = 0; ; attempt++) {
    const r = await call('shop_query', { sql: `select count(*) as n from orders where ${where}` });
    if (!r.isError) return Number(readTable(r.text).rows[0].n);
    if (attempt >= 50 || !/cannot connect to the database|connection to the database was lost/.test(r.text)) assert.fail(r.text);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

test('postgres: a declared query runs with bound parameters and typed results', async () => {
  const r = await json('orders_by_customer', { email: 'ann@example.com' });
  assert.equal(r.rowCount, 2);
  assert.deepEqual(r.rows[0], { id: 3, total: '5.00', status: 'refunded', meta: null, created_at: '2026-03-01T00:00:00.000Z', id_2: 1 });
  const paid = await json('orders_by_customer', { email: 'ann@example.com', status: 'paid', limit: 10 });
  assert.deepEqual(paid.rows.map((x: { id: number }) => x.id), [2, 1]);
  assert.deepEqual(paid.rows[1].meta, { gift: true });
  assert.equal((await json('orders_by_customer', { email: "' or 1=1 --" })).rowCount, 0); // a value is data
  assert.equal(await count(), 4);
});

test('postgres: the row limit is applied by the database and reported', async () => {
  const many = await json('shop_query', { sql: 'select id from orders order by id -- all of them' });
  assert.deepEqual([many.rowCount, many.truncated], [3, true]);
  assert.deepEqual(many.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.match(many.note, /the limit is 3/);
  const agg = await json('shop_query', { sql: "select status, count(*)::int as n from orders group by status order by status" });
  assert.deepEqual(agg.rows, [{ status: 'paid', n: 3 }, { status: 'refunded', n: 1 }]);
});

test('postgres: read-only is enforced by the database, however the query is written', async () => {
  const sneaky = await call('sneaky'); // passes the "starts with WITH" rule; the read-only transaction refuses it
  assert.equal(sneaky.isError, true);
  assert.match(sneaky.text, /only reads: the query tried to change data and the database refused it/);
  for (const [sql, re] of [
    ["with gone as (delete from orders returning id) select count(*) from gone", /only reads/],
    ["select nextval('orders_id_seq')", /only reads/],
    ["delete from orders", /must start with SELECT/],
    ['select 1; delete from orders', /only one statement/],
    ['select * from nope', /relation "nope" does not exist/],
    ['selec 1', /must start with SELECT/],
    ['select 1 +', /syntax error/],
  ] as const) {
    const r = await call('shop_query', { sql });
    assert.equal(r.isError, true, sql);
    assert.match(r.text, re, sql);
  }
  assert.equal(await count(), 4); // nothing was deleted
});

test('postgres: a tool declared with readOnly false writes and commits', async () => {
  const r = await json('refund_order', { id: 4 });
  assert.deepEqual([r.rowsChanged, r.rows], [1, [{ id: 4, status: 'refunded' }]]);
  assert.equal(await count("status = 'paid'"), 2);
});

test('postgres: tables lists what the role can read, with schemas', async () => {
  const text = (await call('shop_tables')).text;
  assert.match(text, /^customers \(table(, about -?\d+ rows)?\): id integer, email text, name text$/m);
  assert.match(text, /^orders \(table.*total numeric, status text, meta jsonb, created_at timestamp with time zone$/m);
  assert.match(text, /^reports\.revenue \(view\): status text, total numeric$/m);
  assert.ok(!/pg_catalog|information_schema/.test(text));
  assert.equal((await json('shop_query', { sql: 'select * from reports.revenue order by status' })).rowCount, 2);
});

test('postgres: check compiles every query without running it, and connection problems hide the password', async () => {
  const cfg = getConfig();
  const lines = await checkConnection('shop', cfg.connections.shop, cfg.tools);
  assert.match(lines[0].text, /^PostgreSQL \d+\.\d+, 3 tables readable, explore on/);
  assert.deepEqual(lines.map((l) => [l.what, l.ok]), [['shop', true], ['shop › orders_by_customer', true], ['shop › refund_order', true], ['shop › sneaky', true], ['shop › nap', true], ['shop › shop_big', true]]);
  assert.equal(await count("status = 'paid'"), 2); // refund_order and sneaky were compiled, not run

  const broken = await checkConnection('shop', cfg.connections.shop, [{ ...cfg.tools[0], sql: 'select nope from orders where :email is not null and :status::text is null limit :limit' }]);
  assert.equal(broken[1].ok, false);
  assert.match(broken[1].text, /column "nope" does not exist/);

  const down = await checkConnection('down', cfg.connections.down, cfg.tools);
  assert.equal(down[0].ok, false);
  assert.match(down[0].text, /cannot connect to the database of "down"/);
  const called = await call('never_called');
  assert.match(called.text, /cannot connect to the database of "down"/);
  for (const t of [down[0].text, called.text]) assert.ok(!t.includes('hunter2-secret') && !t.includes('postgres://'));

  const unset = await checkConnection('unset', cfg.connections.unset, cfg.tools);
  assert.deepEqual([unset[0].ok, unset[0].text], [false, 'set UNSET_DATABASE_URL in .env (the postgres connection reads it)']);
  assert.match(registry.status().find((s) => s.id === 'unset')!.reason!, /missing env UNSET_DATABASE_URL/);
  assert.match((await call('unset_query', { sql: 'select 1' })).text, /not configured \(missing env UNSET_DATABASE_URL\)/);
});

test('postgres: a query past its time limit is stopped and the server keeps answering', async () => {
  const started = Date.now();
  const slow = await call('nap', { seconds: 2.5 });
  assert.equal(slow.isError, true);
  assert.match(slow.text, /took longer than 0\.3s and was stopped/);
  assert.ok(Date.now() - started < 2400, `gave up after ${Date.now() - started}ms`); // 0.3s + the grace of the timer, well before the 2.5s nap ends
  assert.equal(await count(), 4);
});

test('postgres: a query that hides a second statement from the reader of the SQL cannot leave the read-only transaction', async () => {
  // Postgres reads E'\'' as a string holding one quote. A reader that does not know backslash escapes sees the
  // string end early, and takes everything up to the last quote for string content: one statement. Postgres sees
  // three, and the second one ends the read-only transaction.
  const hidden = "select E'\\'' ) as _k; commit; delete from orders; select * from (select '1'";
  const r = await call('shop_query', { sql: hidden });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /multiple commands|only one statement/);
  assert.equal(await count(), 4);
  const plain = await call('shop_query', { sql: "select 1 as a) as _k; commit; delete from orders; select * from (select 2 as a" });
  assert.equal(plain.isError, true);
  assert.equal(await count(), 4);
});

// ── Found by an adversarial review: each of these worked before it was fixed ──

test('postgres: a connection that dies during a query fails that call, not the server', async () => {
  // Before the fix the driver's 'error' event had no listener here, and the whole process ended.
  const r = await call('shop_query', { sql: `select 1 as ${DROP}` });
  assert.equal(r.isError, true);
  assert.match(r.text, /the connection to the database was lost while the query ran; try again/);
  assert.equal(await count(), 4); // a new connection is opened for the next call
});

test('postgres: a session-level advisory lock taken by a query does not stay on the pooled connection', async () => {
  const locks = async () => Number((await json('shop_query', { sql: "select count(*)::int as n from pg_locks where locktype = 'advisory'" })).rows[0].n);
  assert.equal(await locks(), 0);
  await json('shop_query', { sql: 'select pg_advisory_lock(424242) as held' });
  assert.equal(await locks(), 0); // ROLLBACK alone would have left it
  // Taken, then the statement fails: the lock is still released.
  const failed = await call('shop_query', { sql: 'select pg_advisory_lock(424243), 1 / (select 0) as boom' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /division by zero/);
  assert.equal(await locks(), 0);
});

test('postgres: an answer is limited in size as well as in rows', async () => {
  // One row whose value is a 300,000-element array: cut for the model.
  const one = await call('shop_query', { sql: 'select array_agg(g) as a, 1 as n from generate_series(1, 300000) g' });
  assert.equal(one.isError, false, one.text.slice(0, 200));
  assert.ok(one.text.length < 20000, `the answer is ${one.text.length} characters`);
  assert.match(one.text, /more characters\]/);

  // 40 rows of 1 MB each: the row limit (3) does not help, the connection's byte limit does.
  const big = await call('shop_big', {});
  assert.equal(big.isError, true, big.text.slice(0, 200));
  assert.match(big.text, /the answer was larger than 16 MB and was stopped/);
  assert.equal(await count(), 4);
});
