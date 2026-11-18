/**
 * Tools declared in the config (connections + tools): the SQL parameter reader, config validation, the SQLite and
 * HTTP connections against a real file and a real local server, and the whole path through the registry
 * (tool list, permission group, validated call).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ── A SQLite database with two tables ──
const dir = mkdtempSync(join(tmpdir(), 'kmcp-data-'));
const dbPath = join(dir, 'shop.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table customers (id integer primary key, email text, name text);
    create table orders (id integer primary key, customer_id integer, total real, status text, note text, created_at text);
    insert into customers values (1, 'ann@example.com', 'Ann'), (2, 'bob@example.com', 'Bob');
    insert into orders values
      (1, 1, 10.5, 'paid', 'first', '2026-01-01'), (2, 1, 20, 'paid', null, '2026-02-01'),
      (3, 1, 5, 'refunded', 'it''s back', '2026-03-01'), (4, 2, 7, 'paid', null, '2026-03-02');
    create view paid_orders as select * from orders where status = 'paid';
  `);
  db.close();
}
const otherDb = join(dir, 'other.db');
{
  const db = new DatabaseSync(otherDb);
  db.exec("create table secrets (k text); insert into secrets values ('do-not-read')");
  db.close();
}

// ── A local HTTP API ──
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const seen: Seen[] = [];
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const path = req.url!.split('?')[0];
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== 'Bearer s3cret-token') return json(401, { error: 'bad token' });
    if (path === '/api/v2/' || path === '/api/v2') return json(404, { error: 'no such route' });
    if (path.startsWith('/api/v2/contacts/')) return json(200, { data: { id: decodeURIComponent(path.split('/').pop()!), name: 'Ann' }, meta: { took: 3 } });
    if (path === '/api/v2/search') return json(200, { results: [{ id: 1 }, { id: 2 }] });
    if (path === '/api/v2/echo') return json(400, { error: 'bad request', request_url: req.url, your_headers: req.headers });
    if (path === '/api/v2/echo-ok') return json(200, { request_url: req.url, your_headers: req.headers });
    if (path === '/api/v2/moved') return void res.writeHead(302, { location: 'https://elsewhere.example/steal' }).end();
    if (path === '/api/v2/big') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(5000));
    if (path === '/api/v2/slow') return void setTimeout(() => json(200, {}), 1500);
    if (path === '/api/v2/tickets' && req.method === 'POST') return json(201, { created: JSON.parse(body) });
    return json(500, { error: 'boom', detail: 'stack trace here' });
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
after(() => api.close());
const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v2`;

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|EMBEDDING_|KNOWLEDGE_)/.test(k)) delete process.env[k];
const config = {
  access: { viewerTools: ['crm'] },
  connections: {
    shop: { type: 'sqlite', path: dbPath, description: 'Orders and customers', explore: true, maxRows: 3 },
    crm: { type: 'http', baseUrl: apiBase, headers: { Authorization: 'Bearer ${CRM_TOKEN}' }, query: { tenant: '${CRM_TENANT}' }, maxBytes: 2000, timeoutMs: 500 },
    empty: { type: 'sqlite', path: dbPath },
    missing: { type: 'sqlite', path: join(dir, 'nope.db'), explore: true },
  },
  tools: [
    {
      name: 'orders_by_customer',
      connection: 'shop',
      description: 'Orders of one customer, newest first.',
      params: {
        email: { type: 'string', description: 'Customer email' },
        status: { type: 'string', enum: ['paid', 'refunded'], required: false },
        limit: { type: 'integer', default: 2, min: 1, max: 50 },
      },
      sql: `select o.id, o.total, o.status, o.note, c.id -- the customer's id too
              from orders o join customers c on c.id = o.customer_id
             where c.email = :email and (:status is null or o.status = :status)
             order by o.id desc limit :limit;`,
    },
    {
      name: 'refund_order',
      connection: 'shop',
      description: 'Mark an order as refunded.',
      readOnly: false,
      params: { id: { type: 'integer' } },
      sql: "update orders set status = 'refunded' where id = :id",
    },
    {
      name: 'slow_count',
      connection: 'shop',
      description: 'A query that never ends.',
      timeoutMs: 300,
      sql: 'with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) from n',
    },
    { name: 'crm_contact', connection: 'crm', description: 'One CRM contact.', params: { id: { type: 'string' } }, request: { path: '/contacts/{id}', pick: 'data' } },
    {
      name: 'crm_search',
      connection: 'crm',
      description: 'Search contacts.',
      params: { q: { type: 'string' }, page: { type: 'integer', required: false } },
      request: { path: '/search', query: { q: '{q}', page: '{page}', sort: 'name' } },
    },
    {
      name: 'crm_ticket',
      connection: 'crm',
      description: 'Open a ticket.',
      readOnly: false,
      params: { title: { type: 'string' }, priority: { type: 'integer', default: 3 }, urgent: { type: 'boolean', required: false }, team: { type: 'string', required: false } },
      request: { method: 'POST', path: '/tickets', headers: { 'X-Team': '{team}' }, body: { title: 'Ticket: {title}', priority: '{priority}', urgent: '{urgent}', tags: ['api', '{team}'] } },
    },
    { name: 'crm_echo', connection: 'crm', description: 'Echoes the request in an error.', params: { team: { type: 'string' } }, request: { path: '/echo', headers: { 'X-Session': 'session=${CRM_TOKEN}; team={team}' } } },
    { name: 'crm_echo_ok', connection: 'crm', description: 'Echoes the request.', params: { team: { type: 'string' } }, request: { path: '/echo-ok', headers: { 'X-Session': 'session=${CRM_TOKEN}; team={team}' } } },
    { name: 'crm_moved', connection: 'crm', description: 'Redirects.', request: { path: '/moved' } },
    { name: 'crm_big', connection: 'crm', description: 'Large.', request: { path: '/big' } },
    { name: 'crm_slow', connection: 'crm', description: 'Slow.', request: { path: '/slow' } },
    { name: 'crm_boom', connection: 'crm', description: 'Fails.', request: { path: '/boom' } },
  ],
};
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-data-store-')),
  MCP_CONFIG_JSON: JSON.stringify(config),
  CRM_TOKEN: 's3cret-token',
  CRM_TENANT: 'acme',
});

const { parseSql, sqlProblem } = await import('../src/connections/sql.js');
const { dataConfigProblems, ConnectionsSchema, DataToolsSchema } = await import('../src/connections/schema.js');
const { buildUrl, fillBody, fillPath } = await import('../src/connections/http.js');
const { checkConnection, closeDataConnections } = await import('../src/connections/index.js');
const { tableResult } = await import('../src/connections/format.js');
const { readTable } = await import('./helpers/table.js');
const { SQLITE_CHILD_SOURCE } = await import('../src/connections/sqlite.js'); // every awaited import stays above the first test
const { Registry } = await import('../src/plugin/registry.js');
const { getConfig } = await import('../src/core/config.js');
const { isToolAllowed } = await import('../src/core/scope.js');
const { pingTool } = await import('../src/plugin/ping.js');
const { definePlugin } = await import('../src/plugin/define.js');
after(() => closeDataConnections());

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
const problems = (connections: unknown, tools: unknown) => dataConfigProblems(ConnectionsSchema.parse(connections), DataToolsSchema.parse(tools)).map((p) => p.message);

test('parseSql finds :names and nothing that only looks like one', () => {
  const p = parseSql(`select a::text, '12:30 :nope', "col:x", $$ :nope $$, $t$ :nope $t$ /* :nope /* nested */ :nope */
    from t where a = :first and b = :second and c = :first -- :nope
    and d[1:2] is not null;`);
  assert.deepEqual(p.names, ['first', 'second']);
  assert.equal(p.statements, 1);
  assert.equal(p.firstKeyword, 'select');
  assert.match(p.positional, /a = \$1 and b = \$2 and c = \$1/); // one number per name
  assert.ok(p.positional.includes("'12:30 :nope'") && p.positional.includes('a::text') && !p.positional.trimEnd().endsWith(';'));
  assert.equal(parseSql("select 'it''s :x' as a").names.length, 0);
  assert.equal(parseSql('  -- only a comment\n').statements, 0);
  assert.equal(parseSql('select 1; select 2').statements, 2);
  assert.equal(parseSql("select ';' as a;  -- done").statements, 1);
  assert.equal(parseSql('(select 1) union (select 2)').firstKeyword, 'select');
});

test('sqlProblem: one statement, and a read-only query must be a read', () => {
  assert.equal(sqlProblem(parseSql('select 1'), true), null);
  assert.equal(sqlProblem(parseSql('with x as (select 1) select * from x'), true), null);
  assert.match(sqlProblem(parseSql('select 1; drop table t'), true)!, /only one statement/);
  assert.match(sqlProblem(parseSql("attach database 'x.db' as o"), true)!, /starts with ATTACH/);
  assert.match(sqlProblem(parseSql('pragma writable_schema = 1'), true)!, /starts with PRAGMA/);
  assert.match(sqlProblem(parseSql('delete from t'), true)!, /starts with DELETE/);
  assert.equal(sqlProblem(parseSql('delete from t where id = :id'), false), null);
  assert.match(sqlProblem(parseSql(''), false)!, /empty/);
});

test('config mistakes are named with the tool they are in', () => {
  const sqlite = { db: { type: 'sqlite', path: 'x.db' } };
  const http = { api: { type: 'http', baseUrl: 'https://api.example.com/v1' } };
  const tool = (o: object) => [{ name: 't', connection: 'db', description: 'd', ...o }];
  assert.match(problems(sqlite, [{ name: 't', connection: 'nope', description: 'd', sql: 'select 1' }])[0], /no connection named "nope"/);
  assert.match(problems(sqlite, tool({ sql: 'select * from t where a = :emial', params: { email: { type: 'string' } } })).join('|'), /uses :emial but `params` has no "emial".*"email" is declared but never used/);
  assert.match(problems(sqlite, tool({ sql: 'delete from t' }))[0], /must start with SELECT.*set "readOnly": false/);
  assert.deepEqual(problems(sqlite, tool({ sql: 'delete from t', readOnly: false })), []);
  assert.match(problems(sqlite, tool({ sql: 'select 1; select 2' }))[0], /only one statement/);
  assert.match(problems(sqlite, tool({ request: { path: '/x' } })).join('|'), /needs `sql`, not `request`/);
  assert.match(problems(sqlite, tool({ sql: 'select :n', params: { n: { type: 'integer', default: 'ten' } } }))[0], /default does not match the type/);
  assert.match(problems(sqlite, tool({ sql: 'select :n', params: { n: { type: 'integer', min: 5, max: 1 } } }))[0], /min is larger than max/);
  assert.match(problems(sqlite, tool({ sql: 'select :s', params: { s: { type: 'string', pattern: '(' } } }))[0], /not a valid regular expression/);
  assert.match(problems({ db: { type: 'sqlite', path: 'x.db', explore: true } }, [{ name: 'db_query', connection: 'db', description: 'd', sql: 'select 1' }])[0], /already defined by connection "db" \(explore\)/);
  assert.match(problems(sqlite, [...tool({ sql: 'select 1' }), ...tool({ sql: 'select 2' })])[0], /already defined by tool "t"/);

  const api = (o: object) => [{ name: 't', connection: 'api', description: 'd', ...o }];
  assert.match(problems(http, api({ sql: 'select 1' })).join('|'), /needs `request`, not `sql`/);
  assert.match(problems(http, api({ request: { method: 'POST', path: '/x' } }))[0], /POST request must say "readOnly"/);
  assert.deepEqual(problems(http, api({ request: { method: 'POST', path: '/search' }, readOnly: true })), []);
  assert.match(problems(http, api({ request: { path: '/items/{id}' }, params: { id: { type: 'string', required: false } } }))[0], /in the path, so the parameter cannot be optional/);
  assert.match(problems(http, api({ request: { path: '/items/{id}' } }))[0], /uses \{id\} but `params` has no "id"/);
  assert.match(problems(http, api({ request: { method: 'POST', path: '/x', body: { key: '${SECRET}' } }, readOnly: true }))[0], /not in the body/);
  assert.match(problems({ api: { type: 'http', baseUrl: 'https://user:pw@api.example.com' } }, [])[0], /must not hold a user name or password/);
  assert.match(problems({ api: { type: 'http', baseUrl: 'https://api.example.com/v1?key=1' } }, [])[0], /must not hold a query string/);

  // Shape errors are caught by the schema itself.
  assert.throws(() => ConnectionsSchema.parse({ Bad_Name: { type: 'sqlite', path: 'x' } }));
  assert.throws(() => ConnectionsSchema.parse({ db: { type: 'postgres', url: 'postgres://user:pw@host/db' } })); // a URL in the config is refused: only urlEnv
  assert.throws(() => DataToolsSchema.parse([{ name: 't', connection: 'db', description: 'd', sql: 'select 1', extra: true }]));
});

test('the loaded config turns each connection into a plugin with its tools', () => {
  assert.equal(Object.keys(getConfig().connections).length, 4);
  const status = Object.fromEntries(registry.status().map((s) => [s.id, s]));
  assert.equal(status.shop.enabled, true);
  assert.deepEqual(status.shop.tools.map((t) => t.name), ['orders_by_customer', 'refund_order', 'slow_count', 'shop_tables', 'shop_query']);
  assert.equal(status.crm.enabled, true);
  assert.match(status.empty.reason!, /no tools yet/);
  assert.match(status.missing.reason!, /database file does not exist/);
  const listed = registry.listTools(pingTool);
  const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
  assert.ok(!('missing_query' in byName));
  const input = byName.orders_by_customer.inputSchema as { properties: Record<string, { type?: string; enum?: string[]; default?: unknown; maximum?: number; description?: string }>; required?: string[] };
  assert.deepEqual(input.required, ['email']);
  assert.deepEqual([input.properties.limit.type, input.properties.limit.default, input.properties.limit.maximum], ['integer', 2, 50]);
  assert.deepEqual(input.properties.status.enum, ['paid', 'refunded']);
  assert.equal(input.properties.email.description, 'Customer email');
  assert.equal(byName.orders_by_customer.annotations?.readOnlyHint, true);
  assert.deepEqual([byName.refund_order.annotations?.readOnlyHint, byName.refund_order.annotations?.destructiveHint], [false, true]);
  assert.match(registry.instructions(), /"shop" database \(Orders and customers\): call shop_tables/);

  // The connection name is the permission group.
  assert.equal(registry.groupOf('orders_by_customer'), 'shop');
  const member = { ok: true, role: 'member' as const, email: 'm@x.com', scopes: { tools: ['crm'] } };
  assert.equal(isToolAllowed(member as never, 'crm_contact', registry.groupOf('crm_contact')), true);
  assert.equal(isToolAllowed(member as never, 'shop_query', registry.groupOf('shop_query')), false);
  const viewer = { ok: true, role: 'viewer' as const, email: 'v@x.com' };
  assert.equal(isToolAllowed(viewer as never, 'crm_search', registry.groupOf('crm_search')), true); // access.viewerTools: ["crm"]
  assert.equal(isToolAllowed(viewer as never, 'orders_by_customer', registry.groupOf('orders_by_customer')), false);

  assert.throws(() => new Registry([definePlugin({ id: 'shop', tools: [] })]), /connection "shop" has the same name as a plugin/);
});

test('sqlite: a declared query runs with bound parameters, defaults and the row limit', async () => {
  const r = await json('orders_by_customer', { email: 'ann@example.com' });
  assert.equal(r.rowCount, 2); // limit defaults to 2
  assert.deepEqual(r.rows[0], { id: 3, total: 5, status: 'refunded', note: "it's back", id_2: 1 }); // two columns named id
  assert.deepEqual((await json('orders_by_customer', { email: 'ann@example.com', status: 'paid', limit: 10 })).rows.map((x: { id: number }) => x.id), [2, 1]);
  // A value is data, whatever it looks like.
  assert.equal((await json('orders_by_customer', { email: "' or 1=1 --" })).rowCount, 0);
  assert.equal((await json('orders_by_customer', { email: 'ann@example.com; drop table orders' })).rowCount, 0);
  // The connection's maxRows (3) cuts a longer answer and says so.
  const all = await json('orders_by_customer', { email: 'ann@example.com', limit: 50 });
  assert.equal(all.rowCount, 3);
  assert.equal(all.truncated, undefined);
  const many = await json('shop_query', { sql: 'select id from orders order by id' });
  assert.deepEqual([many.rowCount, many.truncated], [3, true]);
  assert.match(many.note, /Only the first 3 rows are shown \(the limit is 3\)/);

  for (const [args, re] of [
    [{}, /email/],
    [{ email: 'a', limit: 0 }, /limit/],
    [{ email: 'a', limit: 1.5 }, /limit/],
    [{ email: 'a', status: 'shipped' }, /status/],
    [{ email: 'a', emial: 'b' }, /emial|unrecognized/i],
    [{ email: 'x'.repeat(2001) }, /email/],
  ] as const) {
    const bad = await call('orders_by_customer', args);
    assert.equal(bad.isError, true);
    assert.match(bad.text, /\[invalid_input\]/);
    assert.match(bad.text, re);
  }
});

test('sqlite: read-only is enforced by the database, a write tool writes, a slow query is stopped', async () => {
  // Starts with WITH, so it passes the reading of the text; the statement SQLite compiled returns no rows and is refused.
  const refused = await call('shop_query', { sql: "with x as (select 1) update orders set status = 'x'" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /only a single SELECT \(or WITH … SELECT\) can be run here/);
  // With RETURNING it does return rows: the read-only file handle refuses it.
  const returning = await call('shop_query', { sql: "with x as (select 1) update orders set status = 'x' returning id" });
  assert.equal(returning.isError, true);
  assert.match(returning.text, /only reads: the query tried to change data/);
  for (const [sql, re] of [
    ["update orders set status = 'x'", /must start with SELECT/],
    [`attach database '${otherDb}' as o`, /starts with ATTACH/],
    ['select 1; delete from orders', /only one statement/],
    ['select * from orders where id = :id', /write the value into the query instead of :id/],
    ['select * from nope', /no such table: nope/],
  ] as const) {
    const r = await call('shop_query', { sql });
    assert.equal(r.isError, true, sql);
    assert.match(r.text, re);
  }
  assert.equal((await json('shop_query', { sql: "select count(*) as n from orders where status = 'paid'" })).rows[0].n, 3);
  // A quote inside a [bracketed] name is not a string in SQLite, so the statements after it are seen and refused.
  const hidden = await call('shop_query', { sql: "select 1 as [a'b]; delete from orders; select '" });
  assert.equal(hidden.isError, true);
  assert.match(hidden.text, /only one statement can be run/);
  assert.equal((await json('shop_query', { sql: 'select count(*) as n from orders' })).rows[0].n, 4);

  const w = await json('refund_order', { id: 4 });
  assert.deepEqual([w.rowsChanged, w.rowCount], [1, 0]);
  assert.equal((await json('shop_query', { sql: "select count(*) as n from orders where status = 'paid'" })).rows[0].n, 2);

  const started = Date.now();
  const slow = await call('slow_count');
  assert.equal(slow.isError, true);
  assert.match(slow.text, /took longer than 0\.3s and was stopped/);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await json('shop_query', { sql: 'select 1 as ok' })).rows[0].ok, 1); // the server is still answering
});

test('sqlite: the tables tool describes what can be queried', async () => {
  const all = (await call('shop_tables')).text;
  assert.match(all, /^customers \(table\): id INTEGER, email TEXT, name TEXT$/m);
  assert.match(all, /^paid_orders \(view\): /m);
  assert.equal((await call('shop_tables', { filter: 'customer_id' })).text.split('\n').length, 2); // orders and the view
  assert.match((await call('shop_tables', { filter: 'zzz' })).text, /No table or column contains "zzz"/);
});

test('http: parameters fill the path, query, headers and body, and cannot change the destination', async () => {
  seen.length = 0;
  assert.deepEqual(await json('crm_contact', { id: 'a/b ../c?x=1#y' }), { id: 'a/b ../c?x=1#y', name: 'Ann' }); // pick: "data"
  assert.equal(seen[0].url, '/api/v2/contacts/a%2Fb%20..%2Fc%3Fx%3D1%23y?tenant=acme');
  assert.equal(seen[0].headers.authorization, 'Bearer s3cret-token');
  for (const id of ['..', '.', '']) {
    const r = await call('crm_contact', { id });
    assert.equal(r.isError, true);
    assert.match(r.text, /cannot be empty, "\." or "\.\."/);
  }
  assert.equal(seen.length, 1); // nothing was sent for those

  await json('crm_search', { q: 'ann & co' });
  assert.equal(seen[1].url, '/api/v2/search?tenant=acme&q=ann+%26+co&sort=name'); // the absent optional `page` is left out
  await json('crm_search', { q: 'x', page: 2 });
  assert.match(seen[2].url, /&page=2&/);

  const t = await json('crm_ticket', { title: 'Printer', urgent: true });
  assert.deepEqual(t.created, { title: 'Ticket: Printer', priority: 3, urgent: true, tags: ['api'] }); // types kept, absent `team` dropped
  assert.equal(seen[3].method, 'POST');
  assert.equal(seen[3].headers['content-type'], 'application/json');
  const injected = await call('crm_ticket', { title: 'x', team: 'a\r\nX-Evil: 1' });
  assert.equal(injected.isError, true); // a header value cannot carry a second header

  // Unit level: the same rules without a server.
  assert.equal(fillPath('/a/{x}/b', { x: 'p q' }), '/a/p%20q/b');
  assert.deepEqual(fillBody({ a: '{n}', b: ['{gone}', 1], c: { d: '{gone}' }, e: 'n={n}' }, { n: 5 }), { a: 5, b: [1], c: {}, e: 'n=5' });
  const u = buildUrl({ baseUrl: 'https://api.example.com/v1/', query: {} }, { path: '/items/{id}' }, { id: '%2e%2e' });
  assert.equal(u.href, 'https://api.example.com/v1/items/%252e%252e');
  assert.throws(() => buildUrl({ baseUrl: 'https://api.example.com/v1', query: {} }, { path: '/../admin' }, {}), /leave the base URL/);
});

test('http: redirects, large answers, slow answers and errors are handled without leaking the token', async () => {
  const moved = await call('crm_moved');
  assert.match(moved.text, /redirect \(HTTP 302 to elsewhere\.example\/steal\)\. Redirects are not followed/);
  const big = await call('crm_big');
  assert.equal(big.isError, false);
  assert.match(big.text, /larger than 2000 bytes and was cut/);
  assert.ok(big.text.length < 2200);
  const slow = await call('crm_slow');
  assert.match(slow.text, /did not answer within 0\.5s/);
  const boom = await call('crm_boom');
  assert.match(boom.text, /HTTP 500 \(127\.0\.0\.1:\d+\/api\/v2\/boom\): \{"error":"boom"/);
  for (const r of [moved, big, slow, boom]) assert.ok(!r.text.includes('s3cret-token') && !r.text.includes('tenant=acme'));

  const saved = process.env.CRM_TOKEN;
  delete process.env.CRM_TOKEN;
  try {
    assert.match(registry.status().find((s) => s.id === 'crm')!.reason!, /missing env CRM_TOKEN/);
    assert.match((await call('crm_contact', { id: '1' })).text, /not configured \(missing env CRM_TOKEN\)/);
  } finally {
    process.env.CRM_TOKEN = saved;
  }
});

test('checkConnection: reachability and whether each query compiles, without running anything', async () => {
  const cfg = getConfig();
  const shop = await checkConnection('shop', cfg.connections.shop, cfg.tools);
  assert.match(shop[0].text, /^SQLite \d+\.\d+\.\d+, 3 tables readable, explore on/);
  assert.deepEqual(shop.map((l) => l.ok), [true, true, true, true]);
  assert.equal(shop[2].what, 'shop › refund_order'); // a write tool is compiled, not run
  assert.equal((await json('shop_query', { sql: "select status from orders where id = 1" })).rows[0].status, 'paid');

  const broken = await checkConnection('shop', cfg.connections.shop, [{ ...cfg.tools[0], sql: 'select nope from orders where a = :email and :status is null limit :limit' }]);
  assert.deepEqual([broken[1].ok, broken[1].what], [false, 'shop › orders_by_customer']);
  assert.match(broken[1].text, /no such column: nope/);

  assert.match((await checkConnection('missing', cfg.connections.missing, []))[0].text, /database file of "missing" does not exist/);
  const crm = await checkConnection('crm', cfg.connections.crm, cfg.tools);
  assert.match(crm[0].text, /127\.0\.0\.1:\d+ answers \(HTTP 404 at the base URL\), 9 tools/);
  const noEnv = await checkConnection('crm', cfg.connections.crm, cfg.tools, { CRM_TENANT: 'acme' });
  assert.deepEqual([noEnv[0].ok, noEnv[0].text], [false, 'set CRM_TOKEN in .env (the http connection reads it)']);
  const badToken = await checkConnection('crm', cfg.connections.crm, cfg.tools, { CRM_TOKEN: 'wrong', CRM_TENANT: 'acme' });
  assert.match(badToken[0].text, /refused the credentials \(HTTP 401/);
  assert.ok(!badToken[0].text.includes('wrong'));
});

test('a large answer is cut to fit, and says so', () => {
  const rows = Array.from({ length: 400 }, (_, i) => [i, 'x'.repeat(1000)]);
  const r = readTable(tableResult({ columns: ['id', 'text'], rows, truncated: false }, 5000)) as { rowCount: number; truncated?: boolean; note?: string };
  assert.ok(r.rowCount < 400 && r.rowCount > 100);
  assert.equal(r.truncated, true);
  assert.match(r.note!, /the answer was too large/);
  const long = readTable(tableResult({ columns: ['t', 'b', 'd'], rows: [['y'.repeat(5000), new Uint8Array(3), new Date('2026-01-02T03:04:05Z')]], truncated: false }, 10)) as { rows: Array<Record<string, string>> };
  assert.match(long.rows[0].t, /… \[1000 more characters\]$/);
  assert.deepEqual([long.rows[0].b, long.rows[0].d], ['[binary, 3 bytes]', '2026-01-02T03:04:05.000Z']);
  writeFileSync(join(dir, 'unused'), ''); // keep the temp dir import used on every platform
});

// ── Found by an adversarial review: each of these worked before it was fixed ──

test('sqlite: a first statement hidden in a comment that SQLite does not nest cannot run (VACUUM INTO, PRAGMA)', async () => {
  // A reader that nests comments sees one comment and then "select 1". SQLite ends the comment at the first */
  // and compiles VACUUM INTO, which writes a copy of the database to any path, even through a read-only handle.
  const out = join(dir, 'copy.db');
  for (const first of [`VACUUM INTO '${out}'`, 'PRAGMA database_list', 'PRAGMA writable_schema = 1', 'CREATE TEMP TABLE t (x)']) {
    const r = await call('shop_query', { sql: `/* /* */ ${first}; /* */ */ select 1` });
    assert.equal(r.isError, true, `${first}: ${r.text}`);
    assert.match(r.text, /only a single SELECT|only one statement|must start with SELECT/, first);
    assert.ok(!r.text.includes(dbPath), 'the path of the database file is not shown');
  }
  assert.equal(existsSync(out), false, 'no file was written');
  // The same statements in the open are refused before they reach the database.
  assert.match((await call('shop_query', { sql: `VACUUM INTO '${out}'` })).text, /must start with SELECT/);
  assert.equal(existsSync(out), false);
  // A real nested-looking comment in front of a real query still works.
  assert.equal((await json('shop_query', { sql: '/* a */ -- b\n select 7 as n' })).rows[0].n, 7);
});

test('sqlite: a very large value is cut where it is produced, and too many waiting queries are refused', async () => {
  // A 30 MB value. An answer over 16 MB is refused, so getting an answer at all shows the value was cut in the
  // child process and never crossed into this one.
  const big = await json('shop_query', { sql: "select printf('%.*c', 30000000, 'x') as big, 1 as n" });
  assert.match(big.rows[0].big, /^x{4000}… \[29996000 more characters\]$/); // cut once, not twice

  // 4 run at a time and 32 may wait; the rest are told to come back instead of piling up.
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 45 }, () => call('slow_count')));
  const refused = results.filter((r) => /too many queries are waiting/.test(r.text)).length;
  const stopped = results.filter((r) => /took longer than 0\.3s and was stopped/.test(r.text)).length;
  assert.deepEqual([refused, stopped], [9, 36]);
  assert.ok(Date.now() - started < 15000);
  assert.equal((await json('shop_query', { sql: 'select 1 as ok' })).rows[0].ok, 1);
});

test('http: a secret of the request never reaches the caller, whatever the API or the runtime says', async () => {
  // The API echoes the request back in an error: the token and the query secret are masked.
  const echoed = await call('crm_echo', { team: 'blue' });
  assert.equal(echoed.isError, true);
  assert.match(echoed.text, /HTTP 400/);
  assert.match(echoed.text, /tenant=\*\*\*/);
  assert.ok(!echoed.text.includes('s3cret-token') && !echoed.text.includes('acme'), echoed.text);
  // The same in a successful answer.
  const ok = await call('crm_echo_ok', { team: 'blue' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /"authorization":"Bearer \*\*\*"/);
  assert.ok(!ok.text.includes('s3cret-token') && !ok.text.includes('acme'));
  // A line break in a parameter that goes into a header with a secret: the error names the header, not its value.
  const broken = await call('crm_echo', { team: 'a\nb' });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /the value for the header "X-Session" holds a character that is not allowed/);
  assert.ok(!broken.text.includes('s3cret-token'));
  // A parameter whose value is the text of an env reference stays text.
  seen.length = 0;
  await call('crm_search', { q: '${CRM_TOKEN}' });
  assert.equal(seen[0].url, '/api/v2/search?tenant=acme&q=%24%7BCRM_TOKEN%7D&sort=name');
  await call('crm_echo_ok', { team: '${CRM_TOKEN}' });
  assert.equal(seen[1].headers['x-session'], 'session=s3cret-token; team=${CRM_TOKEN}');
});

test('a single row that is too large is cut to fit, arrays and JSON values included', () => {
  const huge = Array.from({ length: 300000 }, (_, i) => i);
  const one = readTable(tableResult({ columns: ['a', 'j', 'n'], rows: [[huge, { list: huge }, 5]], truncated: false }, 100)) as { rows: Array<Record<string, unknown>> };
  assert.ok(JSON.stringify(one).length < 20000);
  assert.match(String(one.rows[0].a), /^\[0,1,2,.*… \[\d+ more characters\]$/);
  assert.equal(one.rows[0].n, 5);
  assert.deepEqual((readTable(tableResult({ columns: ['a'], rows: [[[1, 2, 3]]], truncated: false }, 100)) as { rows: unknown[] }).rows, [{ a: [1, 2, 3] }]); // a small one stays an array
  // Sixty long columns: every value is under the cell limit, the row is not.
  const wideText = tableResult({ columns: Array.from({ length: 60 }, (_, i) => `c${i}`), rows: [Array.from({ length: 60 }, () => 'y'.repeat(3900))], truncated: false }, 100);
  const wide = readTable(wideText) as { truncated?: boolean };
  assert.ok(wideText.length < 201000);
  assert.equal(wide.truncated, true);
});

test('rows come back as a compact table: valid JSON, the column names once, one row per line', () => {
  const text = tableResult({ columns: ['id', 'total', 'note'], rows: [[1, 10.5, 'a "quoted" note'], [2, 20, null]], truncated: false }, 100);
  assert.equal(text, '{"rowCount":2,"columns":["id","total","note"],"rows":[\n[1,10.5,"a \\"quoted\\" note"],\n[2,20,null]\n]}');
  assert.deepEqual(readTable(text).rows, [{ id: 1, total: 10.5, note: 'a "quoted" note' }, { id: 2, total: 20, note: null }]);
  assert.equal(tableResult({ columns: ['n'], rows: [], truncated: false }, 100), '{"rowCount":0,"columns":["n"],"rows":[]}');
  assert.equal(tableResult({ columns: [], rows: [], truncated: false, changes: 3 }, 100), '{"rowCount":0,"rowsChanged":3}');
  const cut = JSON.parse(tableResult({ columns: ['n'], rows: [[1], [2]], truncated: true }, 2));
  assert.deepEqual([cut.truncated, /the limit is 2/.test(cut.note), cut.rows], [true, true, [[1], [2]]]);
});

// ── A query must not outlive the server that started it ──
// (Found the hard way: a test process died with 31 endless queries running, and they ran for over an hour.)
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
const ENDLESS = 'with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) from n';
const started: ChildProcess[] = [];
after(() => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); // never leave one behind, whatever a test did
});
function startChild(job: Record<string, unknown>) {
  const child = spawnProcess(process.execPath, ['--no-warnings', '--max-old-space-size=256', '-e', SQLITE_CHILD_SOURCE], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  started.push(child);
  let out = '';
  child.stdout!.on('data', (c) => (out += c));
  const closed = new Promise<{ signal: NodeJS.Signals | null; ms: number; out: string }>((resolve) => {
    const t = Date.now();
    child.on('close', (_code, signal) => resolve({ signal, ms: Date.now() - t, out }));
  });
  child.stdin!.write(`${JSON.stringify({ mode: 'query', path: dbPath, readOnly: true, maxRows: 10, maxCell: 4000, params: {}, timeoutMs: 60000, ...job })}\n`);
  return { child, closed };
}

test('sqlite child: it ends itself when the server that started it is gone', async () => {
  const { child, closed } = startChild({ sql: ENDLESS });
  await new Promise((r) => setTimeout(r, 400)); // the query is running by now
  assert.equal(child.exitCode, null);
  child.stdin!.destroy(); // what the child sees when its parent process dies: the pipe closes
  const end = await closed;
  assert.equal(end.signal, 'SIGKILL');
  assert.ok(end.ms < 5000, `still running ${end.ms}ms after the pipe closed`);
});

test('sqlite child: it ends itself a little past the time limit even when nobody stops it', async () => {
  const { closed } = startChild({ sql: ENDLESS, timeoutMs: 300 }); // the pipe stays open: the "server" is alive but does nothing
  const end = await closed;
  assert.equal(end.signal, 'SIGKILL');
  assert.ok(end.ms >= 2000 && end.ms < 6000, `ended after ${end.ms}ms`);
});

test('sqlite child: an ordinary query answers and exits by itself', async () => {
  const { closed } = startChild({ sql: 'select count(*) as n from customers' });
  const end = await closed;
  assert.equal(end.signal, null);
  assert.deepEqual(JSON.parse(end.out), { ok: { columns: ['n'], rows: [[2]], truncated: false } });
  assert.ok(end.ms < 3000);
});
