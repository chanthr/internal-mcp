/** stdio end to end: the client spawns the server like Claude Code would, from another working directory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = fileURLToPath(new URL('./fixtures/server.ts', import.meta.url));
// Absolute loader path: the server runs from another directory, where a bare `tsx` would not resolve.
const TSX = import.meta.resolve('tsx');
const elsewhere = mkdtempSync(join(tmpdir(), 'kmcp-cwd-'));
const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|MCP_|OAUTH_)/.test(k)) continue;
    env[k] = v;
  }
  env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-stdio-'));
  env.MCP_ENV_FILE = 'none'; // ignore any .env next to the repo
  return env;
};

test('stdio without a key runs as the local admin and serves plugin tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX, server, 'serve', '--stdio'],
    cwd: elsewhere,
    env: cleanEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('echo_text'));
  assert.ok(names.includes('ping'));
  const r = await client.callTool({ name: 'echo_text', arguments: { text: 'yo' } });
  assert.equal((r.content as Array<{ text: string }>)[0]!.text, 'yo (admin)');
  const pingResult = await client.callTool({ name: 'ping', arguments: {} });
  const ping = JSON.parse((pingResult.content as Array<{ text: string }>)[0]!.text);
  assert.equal(ping.authenticated_as, 'local@stdio');
  await client.close();
});

test('MCP_HOME names the folder of the settings and the data, whatever folder the client starts the server in', async () => {
  // What a client's entry looks like when the server comes through npx: no project to find, only the variable.
  const home = mkdtempSync(join(tmpdir(), 'kmcp-home-'));
  const db = new DatabaseSync(join(home, 'shop.db'));
  db.exec('create table orders (id integer primary key, total real); insert into orders values (1, 10)');
  db.close();
  const tool = (name: string) => ({ name, connection: 'shop', description: 'Orders.', sql: 'select id, total from orders' });
  writeFileSync(join(home, 'mcp.config.json'), JSON.stringify({ connections: { shop: { type: 'sqlite', path: join(home, 'shop.db') } }, tools: [tool('home_orders')] }));
  // The client's own project has settings too. They are somebody else's: neither file may be read.
  const project = mkdtempSync(join(tmpdir(), 'kmcp-project-'));
  writeFileSync(join(project, 'other.config.json'), JSON.stringify({ connections: { shop: { type: 'sqlite', path: join(home, 'shop.db') } }, tools: [tool('project_orders')] }));
  writeFileSync(join(project, '.env'), `MCP_CONFIG_PATH=${join(project, 'other.config.json')}\n`);
  writeFileSync(join(project, 'mcp.config.json'), JSON.stringify({ connections: { shop: { type: 'sqlite', path: join(home, 'shop.db') } }, tools: [tool('cwd_orders')] }));

  const env = cleanEnv();
  delete env.MCP_DATA_DIR;
  delete env.MCP_ENV_FILE;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'serve', '--stdio'],
    cwd: project,
    env: { ...env, MCP_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('home_orders'), names.join(', '));
    assert.ok(!names.includes('project_orders') && !names.includes('cwd_orders'), names.join(', '));
    const r = await client.callTool({ name: 'home_orders', arguments: {} });
    assert.deepEqual(JSON.parse((r.content as Array<{ text: string }>)[0]!.text), { rowCount: 1, columns: ['id', 'total'], rows: [[1, 10]] });
    assert.ok(existsSync(join(home, 'data')), 'the data directory is in the home folder');
    assert.ok(!existsSync(join(project, 'data')));
  } finally {
    await client.close();
  }
});

test('stdio with a wrong MCP_API_KEY exits with a clear message', () => {
  const r = spawnSync(process.execPath, ['--import', TSX, server, 'serve', '--stdio'], {
    cwd: elsewhere,
    env: { ...cleanEnv(), MCP_API_KEY: 'kmcp_not_a_real_key_000000000000000000000' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stdio auth failed: key not found/);
});

test('cli: keys create never changes or downgrades a registered role', () => {
  const env = cleanEnv();
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', TSX, server, ...args], { cwd: elsewhere, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(cli('keys', 'create', '--email', 'v@x.com', '--role', 'viewer').status, 2);
  assert.equal(cli('users', 'add', 'a@x.com', '--role', 'admin').status, 0);
  const demote = cli('keys', 'create', '--email', 'a@x.com', '--role', 'member');
  assert.equal(demote.status, 2);
  assert.match(demote.stderr, /already registered as admin/);
  assert.equal(cli('keys', 'create', '--email', 'a@x.com').status, 0); // a key for an admin, role untouched
  assert.equal(cli('keys', 'create', '--email', 'n@x.com', '--role', 'member').status, 0); // registers a new member
  const users = cli('users', 'list').stdout;
  assert.match(users, /a@x\.com\s+admin/);
  assert.match(users, /n@x\.com\s+member/);
  assert.doesNotMatch(users, /v@x\.com/);
});

test('MCP_ENV_FILE naming a missing file stops the process', () => {
  const missing = join(elsewhere, 'nope.env');
  const r = spawnSync(process.execPath, ['--import', TSX, server, 'help'], {
    cwd: elsewhere,
    env: { ...cleanEnv(), MCP_ENV_FILE: missing },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MCP_ENV_FILE points to a file that does not exist/);
});

test('cli: unknown command exits 2, help exits 0', () => {
  const bad = spawnSync(process.execPath, ['--import', TSX, server, 'frobnicate'], { cwd: elsewhere, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(bad.status, 2);
  const help = spawnSync(process.execPath, ['--import', TSX, server, 'help'], { cwd: elsewhere, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /keys create/);
});
