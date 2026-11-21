/**
 * The local console: who may reach it, what its API changes (through the same checks and files as the setup
 * commands), that secrets go in and never come back, and that a saved change restarts the server by itself.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-console-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
writeFileSync(join(docs, 'a.md'), '# A\n\nSome text.\n');
const handbook = join(dir, 'handbook');
mkdirSync(handbook);
writeFileSync(join(handbook, 'deploy.md'), '# Deploy\n\nProduction deploys from the main branch after review.\n');
const dbPath = join(dir, 'shop.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec("create table orders (id integer primary key, total real, status text); insert into orders values (1, 10, 'paid'), (2, 20, 'paid')");
  db.close();
}
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: handbook }], connections: { shop: { type: 'sqlite', path: dbPath, explore: true } } }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on', // a test has no terminal, and without one the console is off
  PORT: '0',
});

const { refusal, consoleToken, consoleEnabled, foreignPage } = await import('../src/admin/auth.js');
const { readTable } = await import('./helpers/table.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { getStore } = await import('../src/store/index.js');

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
const started: ChildProcess[] = [];
after(async () => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await server.close();
});

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/console/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};
const config = () => JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));
const envFile = () => (existsSync(join(dir, '.env')) ? readFileSync(join(dir, '.env'), 'utf8') : '');

test('only a browser on this machine reaches the console', () => {
  const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as never;
  assert.equal(refusal(req('127.0.0.1', { host: 'localhost:8080' })), null);
  assert.equal(refusal(req('::1', { host: '[::1]:8080' })), null);
  assert.equal(refusal(req('::ffff:127.0.0.1', { host: '127.0.0.1:8080' })), null);
  assert.match(refusal(req('192.168.0.7', { host: 'localhost:8080' }))!, /only answers on the machine/); // another machine on the network
  assert.match(refusal(req('127.0.0.1', { host: 'localhost:8080', 'x-forwarded-for': '203.0.113.9' }))!, /not served through a proxy/); // behind nginx every visitor is 127.0.0.1
  assert.match(refusal(req('127.0.0.1', { host: 'mcp.example.com' }))!, /Open the console as http:\/\/localhost/);
  assert.match(refusal(req('127.0.0.1', { host: 'evil.example:8080' }))!, /localhost/); // DNS rebinding: the page's own name
  // Served to a person who started the server in a terminal. A service or a container has none, and gets no
  // console unless it is asked for: a proxy on the same machine that sets no forwarding header looks local.
  assert.equal(consoleEnabled({}, true), true);
  assert.equal(consoleEnabled({}, false), false);
  assert.equal(consoleEnabled({ KNOWLEDGE_CONSOLE: 'on' }, false), true);
  assert.equal(consoleEnabled({ KNOWLEDGE_CONSOLE: 'off' }, true), false);

  // The API answers its own page. What a browser marks as another site's request is refused.
  assert.equal(foreignPage({}), false); // a program: judged by the token
  assert.equal(foreignPage({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:8080' }), false);
  assert.equal(foreignPage({ 'sec-fetch-site': 'cross-site' }), true);
  assert.equal(foreignPage({ 'sec-fetch-site': 'same-site' }), true);
  assert.equal(foreignPage({ origin: 'https://mcp.example.com' }), true); // the page was opened under a public name
  assert.equal(foreignPage({ origin: 'null' }), true);
});

test('the API needs the console token, and the token file is private', async () => {
  assert.equal((await api('GET', '/state', undefined, { Origin: 'https://mcp.example.com' })).status, 403);
  assert.equal((await api('GET', '/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api('GET', '/state', undefined, { 'Sec-Fetch-Site': 'same-origin', Origin: base })).status, 200);
  assert.equal((await fetch(`${base}/console/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/console/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await api('GET', '/state', undefined, { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
  assert.equal(statSync(join(dir, 'data', 'console-token')).mode & 0o777, 0o600);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/console/');
  // A page of another site cannot read the API or send the token header: no CORS permission is given.
  const preflight = await fetch(`${base}/console/api/state`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  // Every answer of the console says it is the console's, the refusals too. The page takes "not allowed" for "the
  // token is not accepted" only then: another program on the same address has no say about the token.
  for (const res of [
    await fetch(`${base}/console/api/state`), // 401
    await fetch(`${base}/console/api/state`, { headers: { Authorization: 'Bearer wrong' } }), // 401
    await fetch(`${base}/console/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), // 403
    await fetch(`${base}/console/api/state`, { headers: { Authorization: `Bearer ${token}` } }), // 200
    await fetch(`${base}/console/api/no-such-thing`, { headers: { Authorization: `Bearer ${token}` } }), // 404
    await fetch(`${base}/console/`),
  ]) {
    assert.equal(res.headers.get('x-knowledge-mcp-console'), '1', `${res.url} ${res.status}`);
  }
  assert.equal((await fetch(`${base}/health`)).headers.get('x-knowledge-mcp-console'), null); // only the console's
});

test('the page: served from this server only, with nothing loaded from elsewhere and no way to frame it', async () => {
  const page = await fetch(`${base}/console/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const csp = page.headers.get('content-security-policy') ?? '';
  for (const part of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no inline or evaluated script');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.ok(!/(src|href)="(https?:)?\/\//.test(html), 'the page refers to its own files only');
  assert.ok(!html.includes(token), 'the token is not in the page');
  for (const file of ['app.js', 'app.css']) {
    const res = await fetch(`${base}/console/${file}`);
    assert.equal(res.status, 200, file);
    assert.ok(!(await res.text()).includes(token));
  }
  // The page is public to this machine (it holds nothing); everything it shows comes from the API, which is not.
  assert.equal((await fetch(`${base}/console/api/state`)).status, 401);
  // Another site's name for this machine (DNS rebinding) gets neither.
  const { get } = await import('node:http');
  const status = await new Promise<number>((done, fail) => get({ host: '127.0.0.1', port: server.port, path: '/console/', headers: { Host: 'evil.example.com' } }, (r) => (r.resume(), done(r.statusCode ?? 0))).on('error', fail));
  assert.ok(status === 403 || status === 404, String(status));
});

test('a token file somebody else could have read is not trusted: a new token is made', () => {
  const data = mkdtempSync(join(tmpdir(), 'kmcp-token-'));
  const path = join(data, 'console-token');
  const old = 'a'.repeat(32);
  writeFileSync(path, `${old}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
  const read = () =>
    spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/admin/auth.ts').then((m) => console.log(m.consoleToken()))"], {
      env: { ...process.env, MCP_DATA_DIR: data },
      encoding: 'utf8',
    }).stdout.trim();
  const fresh = read();
  assert.ok(fresh.length >= 24 && fresh !== old, 'the readable token is replaced');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(read(), fresh, 'a private file is kept');
});

test('the address the server opens in the browser works once and holds no token', async () => {
  const { consoleOpenUrl } = await import('../src/admin/routes.js');
  const url = consoleOpenUrl(server.port);
  assert.ok(!url.includes(token));
  const first = await fetch(url, { redirect: 'manual' });
  assert.deepEqual([first.status, first.headers.get('location')], [302, `/console/#token=${token}`]);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const again = await fetch(url, { redirect: 'manual' });
  assert.deepEqual([again.status, again.headers.get('location')], [302, '/console/']);
  assert.equal((await fetch(`${base}/console/open?code=guess`, { redirect: 'manual' })).headers.get('location'), '/console/');
});

test('a browser without the token can ask the server to open the console, and is handed nothing itself', async () => {
  // In place of the system's opener: each writes down its arguments and what it was given to read.
  const openers = mkdtempSync(join(tmpdir(), 'kmcp-open-'));
  const noted = join(openers, 'opened');
  writeFileSync(join(openers, 'osascript'), `#!/bin/sh\necho "args:$*" >> "${noted}"\ncat >> "${noted}"\n`);
  writeFileSync(join(openers, 'xdg-open'), `#!/bin/sh\necho "args:$*" >> "${noted}"\ncat "$1" >> "${noted}"\n`);
  chmodSync(join(openers, 'osascript'), 0o755);
  chmodSync(join(openers, 'xdg-open'), 0o755);
  const before = { PATH: process.env.PATH, CI: process.env.CI, DISPLAY: process.env.DISPLAY };
  process.env.PATH = `${openers}:${before.PATH}`;
  delete process.env.CI; // a test runner has no desktop, and the server knows it
  process.env.DISPLAY = ':0';
  try {
    const ask = (site?: string) => fetch(`${base}/console/open-here`, { method: 'POST', headers: site ? { 'Sec-Fetch-Site': site } : {} });
    // Another site, and another app on this machine's localhost, cannot make a console pop up.
    assert.deepEqual([(await ask('cross-site')).status, (await ask('same-site')).status], [403, 403]);
    assert.equal(existsSync(noted), false);

    const asked = await ask('same-origin');
    const answer = await asked.text();
    assert.deepEqual([asked.status, JSON.parse(answer)], [200, { ok: true }]);
    assert.ok(!answer.includes(token) && !answer.includes('code='), 'the one who asks gets neither the token nor the address');
    let text = '';
    for (let i = 0; i < 100 && !/code=/.test(text); i++) {
      await new Promise((r) => setTimeout(r, 50));
      text = existsSync(noted) ? readFileSync(noted, 'utf8') : '';
    }
    // The one-time address did not go on a command line, where other users of the machine could read it first.
    const args = text.split('\n').filter((l) => l.startsWith('args:')).join(' ');
    assert.ok(!args.includes('code=') && !args.includes(token), args);
    const url = /http:\/\/localhost:\d+\/console\/open\?code=[\w-]+/.exec(text)?.[0];
    assert.ok(url, text);
    // It leads into the console, once.
    assert.equal((await fetch(url!, { redirect: 'manual' })).headers.get('location'), `/console/#token=${token}`);
    assert.equal((await fetch(url!, { redirect: 'manual' })).headers.get('location'), '/console/');
    // Asked again straight away: not opened over and over.
    assert.equal((await ask('same-origin')).status, 429);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a body the server cannot read is answered in one line, without file paths', async () => {
  for (const path of ['/console/api/run', '/mcp']) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{"name": ' });
    const text = await res.text();
    assert.equal(res.status, 400, path);
    assert.deepEqual(JSON.parse(text), { error: 'The request body is not valid JSON.' });
    assert.ok(!text.includes('node_modules') && !text.includes(' at '), text);
  }
});

test('state: what is set up, without any secret', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-secret-value-1234567890';
  try {
    const { status, json, text } = await api('GET', '/state');
    assert.equal(status, 200);
    assert.equal(json.dir, dir);
    assert.deepEqual([json.editable, json.canRestart], [true, false]);
    assert.deepEqual(json.connections, [{ name: 'shop', type: 'sqlite', description: null, explore: true, target: dbPath, missingEnv: [], tools: 0 }]);
    assert.ok(json.plugins.some((p: { id: string; enabled: boolean }) => p.id === 'shop' && p.enabled));
    assert.ok(json.tools.some((t: { name: string; group: string }) => t.name === 'shop_query' && t.group === 'shop'));
    assert.equal(json.services.slack.set, true);
    assert.ok(!text.includes('xoxb-secret-value'));
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test('how documents are cut is saved under knowledge.index, checked, and the default leaves nothing behind', async () => {
  const saved = await api('POST', '/index/profile', { cut: 'windows', maxTokens: 400, header: 'document' });
  assert.deepEqual([saved.status, saved.json.restartNeeded], [200, true]);
  assert.deepEqual(config().knowledge, { index: { cut: 'windows', maxTokens: 400, header: 'document' } });
  // Prefixes go together: one given, the other is saved empty. The overlap stays under half a passage.
  await api('POST', '/index/profile', { cut: 'sections', maxTokens: 300, overlapTokens: 400, header: 'heading', queryPrefix: 'query: ', passagePrefix: null });
  assert.deepEqual(config().knowledge.index, { cut: 'sections', maxTokens: 300, header: 'heading', overlapTokens: 149, queryPrefix: 'query: ', passagePrefix: '' });
  for (const bad of [{ cut: 'sections', maxTokens: 50, header: 'heading' }, { cut: 'pages', maxTokens: 400, header: 'heading' }, { cut: 'sections', maxTokens: 400, header: 'heading', extra: 1 }]) {
    assert.ok((await api('POST', '/index/profile', bad)).status >= 400, JSON.stringify(bad));
  }
  await api('POST', '/index/profile', { cut: 'sections', maxTokens: 800, header: 'heading' });
  assert.equal(config().knowledge, undefined);
  const m = await api('GET', '/index/measure');
  assert.deepEqual([m.status, m.json.questions, m.json.ways.length], [200, 0, 4]);
});

test('folders, connections and tools are saved through the same checks as the setup commands', async () => {
  const added = await api('POST', '/folders', { path: docs });
  assert.deepEqual([added.status, added.json.restarting, added.json.restartNeeded], [200, false, true]); // nothing supervises a test
  assert.deepEqual(config().folders, [{ path: handbook }, { path: docs }]);
  assert.match((await api('POST', '/folders', { path: join(dir, 'nope') })).json.error, /is not a folder/);

  // A Postgres URL goes to .env under a name of its own, and is checked before it is saved.
  const bad = await api('POST', '/connections', { name: 'pg', type: 'postgres', url: 'postgres://app:hunter2-secret@127.0.0.1:1/app' });
  assert.equal(bad.status, 422);
  assert.match(bad.json.error, /cannot connect to the database of "pg"/);
  assert.ok(!bad.text.includes('hunter2-secret'));
  assert.ok(!envFile().includes('PG_DATABASE_URL') && !config().connections.pg);

  const sqlite = await api('POST', '/connections', { name: 'books', type: 'sqlite', path: dbPath, description: 'Orders' });
  assert.equal(sqlite.status, 200);
  assert.match(sqlite.json.found, /^SQLite \d+\.\d+\.\d+, 1 table$/);
  assert.deepEqual(config().connections.books, { type: 'sqlite', path: dbPath, description: 'Orders' });

  for (const [body, re] of [
    [{ name: 'drive', type: 'sqlite', path: dbPath }, /built-in plugin/],
    [{ name: 'Bad Name', type: 'sqlite', path: dbPath }, /lowercase letters/],
    [{ name: 'x', type: 'sqlite', path: join(dir, 'nope.db') }, /does not exist/],
    [{ name: 'crm', type: 'http', baseUrl: 'https://crm.example.com', headers: { Authorization: 'Bearer abc123' } }, /looks like a secret/],
    [{ name: 'crm', type: 'http', baseUrl: 'https://user:pw@crm.example.com' }, /user name or password/],
  ] as const) {
    const r = await api('POST', '/connections', body);
    assert.ok(r.status === 400 || r.status === 422, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
  const http = await api('POST', '/connections', { name: 'crm', type: 'http', baseUrl: 'https://crm.example.com/api', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } });
  assert.equal(http.status, 200);

  // A ${NAME} written here is filled from the server's environment and sent to the address of the connection.
  // So it may name what is in this folder's .env, or what is not set yet: not the server's own credentials, and
  // not a variable the server only inherited from the shell it was started in.
  process.env.SHELL_ONLY_KEY = 'inherited-from-the-shell-000';
  try {
    const own = await api('POST', '/connections', { name: 'crm2', type: 'http', baseUrl: 'https://crm.example.com', headers: { 'X-Token': '${SLACK_BOT_TOKEN}' } });
    assert.equal(own.status, 422);
    assert.match(own.json.error, /SLACK_BOT_TOKEN\} is one of the server's own settings/);
    const inherited = await api('POST', '/connections', { name: 'crm2', type: 'http', baseUrl: 'https://crm.example.com', headers: { 'X-Token': '${SHELL_ONLY_KEY}' } });
    assert.equal(inherited.status, 422);
    assert.match(inherited.json.error, /not in \.env/);
    assert.equal(config().connections.crm2, undefined);
    const request = { name: 'crm_lookup', connection: 'crm', description: 'Look up.', request: { path: '/x', headers: { 'X-Other': '${SHELL_ONLY_KEY}' } } };
    assert.match((await api('POST', '/tools/check', request)).json.problems.join(' '), /not in \.env/);
    assert.equal((await api('POST', '/tools', request)).status, 422);
    assert.equal((await api('POST', '/tools', { ...request, request: { path: '/x', query: { key: '${SHOP_DATABASE_URL}' } } })).status, 422);
  } finally {
    delete process.env.SHELL_ONLY_KEY;
  }

  // A form field is one line. A line break in a value would become a line of its own in .env.
  for (const body of [
    { baseUrl: 'http://127.0.0.1:1/v1', model: 'model\rOTHER=1' },
    { baseUrl: 'http://127.0.0.1:1/v1\nOTHER=1', model: 'm' },
    { baseUrl: 'not an address', model: 'm' },
    { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'key with spaces' },
  ]) {
    assert.equal((await api('POST', '/services/embeddings', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await api('POST', '/services/slack', { token: 'xoxb-0000000000\nOTHER=1' })).status, 400);
  assert.equal((await api('POST', '/connections', { name: 'pg', type: 'postgres', url: 'postgres://u:p@127.0.0.1:1/db\nOTHER=1' })).status, 400);
  assert.ok(!envFile().includes('OTHER'));

  // A tool: the definition is checked, and the query is compiled on the real database, before anything is saved.
  const tool = { name: 'orders_over', connection: 'shop', description: 'Orders over an amount.', params: { min: { type: 'number' } }, sql: 'select id, total from orders where total >= :min' };
  assert.deepEqual((await api('POST', '/tools/check', tool)).json, { ok: true, note: 'The query compiles on the database.' });
  assert.match((await api('POST', '/tools/check', { ...tool, sql: 'select totl from orders where total >= :min' })).json.problems[0], /no such column: totl/);
  assert.match((await api('POST', '/tools/check', { ...tool, sql: 'select 1' })).json.problems.join(' '), /"min" is declared but never used/);
  assert.equal((await api('POST', '/tools', { ...tool, sql: 'delete from orders where total >= :min' })).status, 422);
  assert.equal((await api('POST', '/tools', { ...tool, name: 'shop_query' })).status, 422); // the explore tool has that name
  assert.equal((await api('POST', '/tools', tool)).status, 200);
  assert.deepEqual(config().tools, [tool]);
  assert.equal((await api('DELETE', '/connections/shop')).status, 409); // a tool still uses it
  assert.equal((await api('DELETE', '/tools/orders_over')).status, 200);
  assert.deepEqual(config().tools, []);
  assert.equal((await api('DELETE', '/connections/books')).status, 200);
  assert.equal(config().connections.books, undefined);
  assert.equal((await api('DELETE', '/folders', { path: docs })).status, 200);
  assert.deepEqual(config().folders, [{ path: handbook }]);
});

test('a tool can be tried, tables can be listed, and a secret typed in is never shown again', async () => {
  const run = await api('POST', '/run', { name: 'shop_query', args: { sql: 'select count(*) as n from orders' } });
  assert.equal(run.json.ok, true);
  assert.equal(readTable(run.json.text).rows[0].n, 2);
  assert.equal((await api('POST', '/run', { name: 'shop_query', args: { sql: 'delete from orders' } })).json.ok, false);
  assert.match((await api('POST', '/run', { name: 'no_such_tool', args: {} })).json.text, /Unknown tool/);
  // A built-in tool asks who is calling: the console calls as the local admin, like a client on this machine.
  let found = { ok: false, text: '' };
  for (let i = 0; i < 40 && !/deploy\.md/.test(found.text); i++) {
    found = (await api('POST', '/run', { name: 'search_knowledge', args: { query: 'production deploys' } })).json;
    if (!/deploy\.md/.test(found.text)) await new Promise((r) => setTimeout(r, 250)); // the first scan is still running
  }
  assert.equal(found.ok, true, found.text);
  assert.match(found.text, /deploy\.md/);
  const tables = await api('GET', '/connections/shop/tables');
  assert.deepEqual(tables.json.tables, [{ name: 'orders', kind: 'table', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'total', type: 'REAL' }, { name: 'status', type: 'TEXT' }] }]);
  assert.equal((await api('GET', '/connections/crm/tables')).status, 404);

  // A token that the service rejects is not saved. (Nothing listens on the default endpoints in a test, so this
  // stops at "could not reach": what matters is that the value appears nowhere.)
  const slack = await api('POST', '/services/slack', { token: 'xoxb-typed-secret-0000000000' });
  assert.notEqual(slack.status, 200);
  assert.ok(!slack.text.includes('typed-secret') && !envFile().includes('typed-secret'));
  const removed = await api('DELETE', '/services/slack');
  assert.equal(removed.status, 200);

  // Disconnecting Drive deletes the key that was pasted into the console, and no key file that is somebody's own.
  const pasted = join(dir, 'drive-service-account.json');
  const own = join(dir, 'my-own-key.json');
  writeFileSync(pasted, '{}');
  writeFileSync(own, '{}');
  writeFileSync(join(dir, '.env'), `${envFile()}GOOGLE_APPLICATION_CREDENTIALS=${own}\n`);
  assert.equal((await api('DELETE', '/services/drive')).status, 200);
  assert.ok(existsSync(own) && existsSync(pasted), 'a key file the env does not point at is left alone');
  writeFileSync(join(dir, '.env'), `${envFile()}GOOGLE_APPLICATION_CREDENTIALS=${pasted}\n`);
  assert.equal((await api('DELETE', '/services/drive')).status, 200);
  assert.ok(!existsSync(pasted) && existsSync(own));
  assert.ok(!/^GOOGLE_APPLICATION_CREDENTIALS=/m.test(envFile()));
});

test('people and keys: a key is shown once, and the list never holds it', async () => {
  const key = await api('POST', '/people/keys', { email: 'Ann@Example.com', label: 'laptop' });
  assert.equal(key.status, 200);
  assert.match(key.json.key, /^[A-Za-z0-9_-]{20,}$/);
  const people = await api('GET', '/people');
  assert.deepEqual(people.json.users.map((u: { email: string; role: string }) => [u.email, u.role]), [['ann@example.com', 'member']]);
  assert.equal(people.json.keys.length, 1);
  assert.ok(!people.text.includes(key.json.key));
  assert.ok(people.json.groups.includes('shop'));
  // The key works on the MCP endpoint, as that person.
  assert.equal((await (await getStore()).validateKey(key.json.key)).ok, true);
  assert.equal((await api('POST', '/people/users', { email: 'ann@example.com', role: 'member', tools: ['shop'] })).status, 200);
  assert.deepEqual((await api('GET', '/people')).json.users[0].allowedTools, ['shop']);
  assert.equal((await api('POST', `/people/keys/${key.json.id}/revoke`)).status, 200);
  assert.equal((await (await getStore()).validateKey(key.json.key)).ok, false);
  assert.equal((await api('DELETE', '/people/users/ann@example.com')).status, 200);
  assert.equal((await api('POST', '/people/keys', { email: 'not-an-email' })).status, 400);
});

test('activity, the client snippets and the live check', async () => {
  const store = await getStore();
  await store.logToolCall({ tool: 'shop_query', email: 'ann@example.com', role: 'member', ok: true, error: null, durationMs: 42 });
  await store.logToolCall({ tool: 'search_knowledge', email: null, role: 'admin', ok: false, error: 'boom', durationMs: 7 });
  const calls = (await api('GET', '/activity?limit=2')).json.calls;
  assert.deepEqual(calls.map((c: { tool: string; ok: boolean; durationMs: number }) => [c.tool, c.ok, c.durationMs]), [['search_knowledge', false, 7], ['shop_query', true, 42]]);
  assert.match(calls[0].at, /^\d{4}-\d{2}-\d{2}T/);
  // What was tried from the console (in the test above) is in the same record, under the console's name.
  const all = (await api('GET', '/activity?limit=100')).json.calls as Array<{ tool: string; email: string | null; ok: boolean; error: string | null }>;
  assert.ok(all.some((c) => c.email === 'console@localhost' && c.tool === 'shop_query' && c.ok));
  assert.ok(all.some((c) => c.email === 'console@localhost' && c.tool === 'shop_query' && !c.ok && c.error));

  const clients = (await api('GET', '/clients')).json;
  assert.equal(clients.url, `http://localhost:${server.port}/mcp`);
  assert.deepEqual(clients.clients.map((c: { id: string }) => c.id), ['claude-code', 'claude-desktop', 'cursor', 'vscode']);
  // This folder is not a project, so the server comes through npx and the entry names the folder.
  const byHand = clients.clients[0].manual.text as string;
  assert.match(byHand, new RegExp(`^claude mcp add --scope user ${clients.name} -e MCP_HOME=\\S*${dir.split('/').pop()} .* -- \\S*npx -y @chnxthr/knowledge-mcp serve --stdio$`));
  assert.equal(JSON.parse(clients.clients[1].manual.text).mcpServers[clients.name].env.MCP_HOME, dir);
  assert.match(clients.clients[2].link, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=/);
  // Which client is the only thing a request chooses. (Cursor adds a server itself, through its link.)
  assert.equal((await api('POST', '/clients/terminal/add')).status, 400);
  assert.match((await api('POST', '/clients/cursor/add')).json.error, /use the link/);

  const check = (await api('GET', '/check')).json.lines;
  assert.ok(check.some((l: { ok: boolean | null; what: string; text: string }) => l.ok === true && l.what === 'shop' && /SQLite/.test(l.text)));
  assert.ok(check.some((l: { ok: boolean | null; what: string }) => l.ok === null && l.what === 'drive'));
  assert.equal((await api('GET', '/nope')).status, 404);
});

// ── The supervisor: a saved change restarts the server, and the server never outlives it ──
test('clients: what is on this machine, and adding the server to each without disturbing what is there', async () => {
  const { describeClients, addToClient, cursorLink, claudeDesktopConfig } = await import('../src/admin/clients.js');
  const home = mkdtempSync(join(tmpdir(), 'kmcp-clients-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'code']) writeFileSync(join(bin, name), '');
  const calls: string[][] = [];
  let status = 0;
  const ctx = {
    home,
    platform: 'darwin' as const,
    env: { PATH: bin },
    exec: (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status, stdout: '', stderr: status ? 'no such option' : '' }),
  };
  const entry = { name: 'team', command: '/opt/node/bin/npx', args: ['-y', '@chnxthr/knowledge-mcp', 'serve', '--stdio'], env: { MCP_HOME: '/srv/team mcp' } };
  const seen = () => describeClients(entry, ctx).map((c) => [c.id, c.installed, c.added]);

  // Two command lines are there, the two desktop apps are not.
  assert.deepEqual(seen(), [['claude-code', true, false], ['claude-desktop', false, false], ['cursor', false, false], ['vscode', true, null]]);
  assert.throws(() => addToClient('claude-desktop', entry, ctx), /was not found on this machine/);

  // Claude Desktop keeps its servers in a file: one entry goes in, the rest stays, and the file as it was is kept.
  const file = claudeDesktopConfig(ctx);
  mkdirSync(join(file, '..'), { recursive: true });
  const before = JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' });
  writeFileSync(file, before);
  assert.match(addToClient('claude-desktop', entry, ctx), /Added to Claude Desktop as "team"\. Quit Claude Desktop/);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([Object.keys(saved.mcpServers), saved.theme], [['other', 'team'], 'dark']);
  assert.deepEqual(saved.mcpServers.team, { command: entry.command, args: entry.args, env: entry.env });
  assert.equal(readFileSync(`${file}.before-team`, 'utf8'), before);
  assert.deepEqual(seen()[1], ['claude-desktop', true, true]);
  // A file that is not JSON is somebody's work in progress: it is left exactly as it is.
  writeFileSync(file, '{ "mcpServers": ');
  assert.throws(() => addToClient('claude-desktop', entry, ctx), /is not valid JSON, so it was left alone/);
  assert.equal(readFileSync(file, 'utf8'), '{ "mcpServers": ');

  // Claude Code and VS Code have a command for it. One of ours that is already there is replaced, not doubled.
  addToClient('claude-code', entry, ctx);
  assert.deepEqual(calls.pop(), ['claude', 'mcp', 'add', '--scope', 'user', 'team', '-e', 'MCP_HOME=/srv/team mcp', '--', entry.command, ...entry.args]);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { team: {} } }));
  calls.length = 0;
  addToClient('claude-code', entry, ctx);
  assert.deepEqual(calls.map((c) => c.slice(0, 3).join(' ')), ['claude mcp remove', 'claude mcp add']);
  addToClient('vscode', entry, ctx);
  assert.deepEqual(JSON.parse(calls.pop()![2]), { name: 'team', type: 'stdio', command: entry.command, args: entry.args, env: entry.env });
  status = 1;
  assert.throws(() => addToClient('vscode', entry, ctx), /`code --add-mcp` did not work: no such option/);

  // Cursor installs from its own link, which carries the entry and nothing else.
  const link = new URL(cursorLink(entry));
  assert.equal(link.searchParams.get('name'), 'team');
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString()), { command: entry.command, args: entry.args, env: entry.env });
});

/** An embedding endpoint for the tests below: it lists models, and answers with vectors of three numbers. */
const fakeModels = async () => {
  const { createServer: http } = await import('node:http');
  const seen: Array<{ path: string; auth: string | undefined; model?: string }> = [];
  const srv = http((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, model: parsed.model });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return void res.end(JSON.stringify({ data: [{ id: 'chat-large' }, { id: 'nomic-embed-text' }, { id: 'bge-m3' }] }));
      if (req.url === '/v1/embeddings') {
        const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        return void res.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, seen, close: () => new Promise((r) => srv.close(() => r(null))) };
};

test('embedding model: the models of an endpoint are listed, and a saved key goes only where it was saved for', async () => {
  const fake = await fakeModels();
  try {
    const listed = await api('POST', '/embeddings/models', { baseUrl: fake.base });
    assert.deepEqual(listed.json.models, ['bge-m3', 'nomic-embed-text', 'chat-large']); // the likely ones first
    assert.deepEqual((await api('POST', '/embeddings/models', {})).json.models, ['text-embedding-3-small', 'text-embedding-3-large']);
    // A key saved for another endpoint is not sent to this one. A key saved for this one is.
    Object.assign(process.env, { EMBEDDING_API_KEY: 'key-of-another-endpoint-000', EMBEDDING_BASE_URL: 'https://embeddings.example.com/v1' });
    await api('POST', '/embeddings/models', { baseUrl: fake.base });
    assert.equal(fake.seen.at(-1)!.auth, undefined);
    process.env.EMBEDDING_BASE_URL = fake.base;
    await api('POST', '/embeddings/models', { baseUrl: `${fake.base}/` });
    assert.equal(fake.seen.at(-1)!.auth, 'Bearer key-of-another-endpoint-000');

    // Saving asks the model first and writes what it answered with.
    const saved = await api('POST', '/services/embeddings', { baseUrl: fake.base, model: 'bge-m3' });
    assert.deepEqual([saved.status, saved.json.found], [200, 'bge-m3 (3 dimensions)']);
    assert.match(envFile(), new RegExp(`^EMBEDDING_BASE_URL=${fake.base}$`, 'm'));
    assert.match(envFile(), /^EMBEDDING_MODEL=bge-m3$\n^EMBEDDING_DIM=3$/m);
    assert.ok(!envFile().includes('key-of-another-endpoint'), 'a key that was not typed in is not written');

    // A new address saved without a key: the key saved for the old one is removed, or every request for vectors
    // would carry it to the new address after the restart.
    const { updateEnvFile } = await import('../src/setup/envfile.js');
    const keyFor = (endpoint: string, key: string) => {
      updateEnvFile(join(dir, '.env'), { EMBEDDING_BASE_URL: endpoint, EMBEDDING_API_KEY: key });
      Object.assign(process.env, { EMBEDDING_BASE_URL: endpoint, EMBEDDING_API_KEY: key });
    };
    keyFor('https://embeddings.example.com/v1', 'key-of-the-old-endpoint-000');
    assert.equal((await api('POST', '/services/embeddings', { baseUrl: fake.base, model: 'bge-m3' })).status, 200);
    assert.equal(fake.seen.at(-1)!.auth, undefined);
    assert.doesNotMatch(envFile(), /^EMBEDDING_API_KEY=/m);
    // The same address again without a key keeps the key saved for it.
    keyFor(fake.base, 'key-of-this-endpoint-000');
    assert.equal((await api('POST', '/services/embeddings', { baseUrl: fake.base, model: 'bge-m3' })).status, 200);
    assert.match(envFile(), /^EMBEDDING_API_KEY=key-of-this-endpoint-000$/m);
  } finally {
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    await api('DELETE', '/services/embeddings');
    await fake.close();
  }
  delete process.env.OPENAI_API_KEY;
  assert.match((await api('POST', '/services/embeddings', { model: 'text-embedding-3-large' })).json.error, /OpenAI needs an API key/);
  // Nothing is configured in this process, so there is nothing to make vectors with: the job says so and changes nothing.
  assert.equal((await api('POST', '/index/reembed')).status, 200);
  await until('the job to end', async () => (await api('GET', '/state')).json.index.job?.running === false);
  assert.match((await api('GET', '/state')).json.index.job.error, /No embedding model is configured/);
});

test('changing the embedding model: search by meaning pauses, and new vectors are made from the console', async () => {
  const fake = await fakeModels();
  const home = mkdtempSync(join(tmpdir(), 'kmcp-model-'));
  mkdirSync(join(home, 'docs'));
  writeFileSync(join(home, 'docs', 'leave.md'), '# Leave\n\nAnnual leave is requested three days ahead.\n');
  writeFileSync(join(home, 'mcp.config.json'), JSON.stringify({ folders: [{ path: join(home, 'docs') }] }));
  const port = await freePort();
  const start = (model: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
      env: { ...process.env, MCP_DATA_DIR: join(home, 'data'), MCP_CONFIG_PATH: join(home, 'mcp.config.json'), PORT: String(port), EMBEDDING_BASE_URL: fake.base, EMBEDDING_MODEL: model, EMBEDDING_DIM: '3' },
      stdio: 'ignore',
    });
    started.push(child);
    return child;
  };
  const stop = (child: ChildProcess) => new Promise<void>((r) => (child.once('exit', () => r()), child.kill('SIGTERM')));
  const state = async () => {
    const res = await fetch(`http://localhost:${port}/console/api/state`, { headers: { Authorization: `Bearer ${readFileSync(join(home, 'data', 'console-token'), 'utf8').trim()}` } });
    type Index = { chunks: number; withVectors: number; problem: string | null; vectorsFrom: string | null; job: { running: boolean; error: string | null } | null };
    return ((await res.json()) as { index: Index }).index;
  };
  try {
    let child = start('bge-m3');
    await until('the first vectors', async () => {
      const i = await state();
      return i.chunks > 0 && i.withVectors === i.chunks;
    });
    assert.equal((await state()).problem, null);
    await stop(child);

    // Another model: its vectors cannot be compared with the stored ones, so nothing is searched by meaning.
    child = start('nomic-embed-text');
    await until('the server to be back', async () => (await state()).chunks > 0);
    const paused = await state();
    assert.equal(paused.vectorsFrom, 'bge-m3');
    assert.match(paused.problem ?? '', /vectors made by bge-m3/);

    const token = readFileSync(join(home, 'data', 'console-token'), 'utf8').trim();
    const asked = fake.seen.length;
    assert.equal((await fetch(`http://localhost:${port}/console/api/index/reembed`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 200);
    await until('the new vectors', async () => {
      const i = await state();
      return i.job?.running === false && i.withVectors === i.chunks;
    });
    const done = await state();
    assert.deepEqual([done.problem, done.job?.error, done.vectorsFrom], [null, null, 'nomic-embed-text']);
    assert.ok(fake.seen.slice(asked).some((r) => r.path === '/v1/embeddings' && r.model === 'nomic-embed-text'));
    await stop(child);
  } finally {
    await fake.close();
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
const until = async (what: string, fn: () => Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

test('supervised: saving in the console restarts the server with the new settings; killing the supervisor stops the server', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kmcp-sup-'));
  writeFileSync(join(home, 'mcp.config.json'), '{}');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_DATA_DIR: join(home, 'data'), MCP_CONFIG_PATH: join(home, 'mcp.config.json'), KMCP_SUPERVISE: 'true', PORT: String(port) };
  let log = '';
  const sup = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  started.push(sup);
  sup.stderr!.on('data', (c) => (log += c));
  const url = `http://localhost:${port}`;
  await until('the server', async () => (await fetch(`${url}/health`)).ok);
  await until('the console line', async () => /console · http:\/\/localhost:\d+\/console\//.test(log));
  assert.ok(!log.includes('#token='), 'the token is not written to a log that is not a terminal');
  const t = readFileSync(join(home, 'data', 'console-token'), 'utf8').trim();
  const call = async (method: string, path: string, body?: unknown) =>
    (await fetch(`${url}/console/api${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;

  const before = await call('GET', '/state');
  assert.deepEqual([before.canRestart, before.folders.length], [true, 0]);
  const saved = await call('POST', '/folders', { path: docs });
  assert.deepEqual([saved.ok, saved.restarting], [true, true]);
  // The server goes away and comes back by itself. Document search was off (nothing to search); the restarted
  // server has read the new settings, so it is on.
  assert.ok(before.plugins.some((p: { id: string; enabled: boolean }) => p.id === 'knowledge' && !p.enabled));
  await until('the restarted server', async () => (await call('GET', '/state')).plugins.some((p: { id: string; enabled: boolean }) => p.id === 'knowledge' && p.enabled));
  assert.match(log, /settings changed, starting again/);

  // The supervisor dies without a chance to clean up: the server must not stay behind on the port.
  sup.kill('SIGKILL');
  await until('the server to stop', async () => {
    try {
      await fetch(`${url}/health`);
      return false;
    } catch {
      return true;
    }
  });
});

test('a port another program already answers on is not shared: the server says so and does not start', async () => {
  // A program that listens on 127.0.0.1 only. The system lets a second one listen on "every address" beside it,
  // and a browser on localhost then reaches one or the other.
  const other = createServer((socket) => socket.end());
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const { port } = other.address() as AddressInfo;
  try {
    const home = mkdtempSync(join(tmpdir(), 'kmcp-port-'));
    writeFileSync(join(home, 'mcp.config.json'), '{}');
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_DATA_DIR: join(home, 'data'), MCP_CONFIG_PATH: join(home, 'mcp.config.json'), PORT: String(port) };
    const run = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    started.push(run);
    let log = '';
    run.stderr!.on('data', (c) => (log += c));
    const code = await new Promise<number | null>((r) => run.on('exit', r));
    assert.notEqual(code, 0, log);
    assert.match(log, new RegExp(`Port ${port} is already used by another program on this computer\\. Start on another port \\(PORT=${port + 10}`));
    assert.ok(!log.includes('listening on'), 'it did not start beside the other program');
    assert.ok(!/\n\s+at .*\(.*:\d+:\d+\)/.test(log), `no stack trace for something a person can fix:\n${log}`);
  } finally {
    await new Promise((r) => other.close(r));
  }
});
