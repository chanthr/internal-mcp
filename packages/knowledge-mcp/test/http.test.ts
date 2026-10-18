/**
 * End to end over Streamable HTTP with the real MCP client: keys from the SQLite store, role filtering,
 * custom plugin tools, plugin state, the read-only gateway to a remote MCP server, and 401s.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

for (const k of Object.keys(process.env)) {
  if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|MCP_OAUTH|OAUTH_)/.test(k)) delete process.env[k];
}
process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-http-'));
process.env.MCP_STORE = 'sqlite';
process.env.PORT = '0';
process.env.TRUST_PROXY = 'false';

// A remote MCP server for the gateway: one read tool, one write tool, one name that collides with a local tool.
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const express = (await import('express')).default;
const { z } = await import('zod');
const remoteApp = express();
remoteApp.use(express.json());
remoteApp.post('/mcp', async (req, res) => {
  const s = new McpServer({ name: 'remote', version: '1.0.0' });
  s.tool('get_weather', 'Weather', { city: z.string() }, async ({ city }) => ({ content: [{ type: 'text', text: `sunny in ${city}` }] }));
  s.tool('delete_everything', 'Danger', {}, async () => ({ content: [{ type: 'text', text: 'deleted' }] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => void t.close());
  await s.connect(t);
  await t.handleRequest(req, res, req.body);
});
const remote = remoteApp.listen(0);
await new Promise((r) => remote.once('listening', r));
const remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;
process.env.REMOTE_TEST_TOKEN = 'remote-token-value-123';
process.env.MCP_CONFIG_JSON = JSON.stringify({
  orgId: 'acme',
  access: { viewerTools: ['echo'] },
  upstreams: [{ name: 'weather', url: remoteUrl, tokenEnv: 'REMOTE_TEST_TOKEN' }],
});

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { getStore } = await import('../src/store/index.js');

const store = await getStore();
await store.upsertUser({ email: 'admin@acme.com', role: 'admin' });
await store.upsertUser({ email: 'member@acme.com', role: 'member', allowedTools: ['weather'] });
const adminKey = (await store.createKey({ email: 'admin@acme.com', orgId: 'acme' })).key;
const memberKey = (await store.createKey({ email: 'member@acme.com', orgId: 'acme' })).key;
const viewerKey = (await store.createKey({ email: 'stranger@acme.com', orgId: 'acme' })).key;
// A trusted proxy (e.g. a chat bot) that acts for signed-in people. http.ts reads this list when it loads.
const proxy = await store.createKey({ orgId: 'acme', role: 'member', label: 'bot' });
process.env.ACT_AS_ALLOWED_KEY_IDS = proxy.id;

const { Registry } = await import('../src/plugin/registry.js');
const { loadPlugins } = await import('../src/plugin/load.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { runHttp } = await import('../src/server/http.js');

const registry = new Registry([...builtinPlugins, ...(await loadPlugins(new URL('./fixtures/plugins/', import.meta.url)))]);
const server = await runHttp(registry);
await registry.upstreams.connectAll(); // runHttp starts it in the background; wait for it here
const base = `http://127.0.0.1:${server.port}`;

async function connect(key: string, extra: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}`, ...extra } } }),
  );
  return client;
}
const textOf = (r: unknown) => String((r as { content: Array<{ text?: string }> }).content[0]?.text ?? '');

after(async () => {
  await server.close();
  remote.close();
  remote.closeAllConnections();
});

test('health needs no auth', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { ok: boolean }).ok, true);
});

test('a wrong key gets 401', async () => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer kmcp_wrong', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(r.status, 401);
});

test('admin sees every enabled tool, remote write tools are hidden, gated plugin is off', async () => {
  const c = await connect(adminKey);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['echo_count', 'echo_fail', 'echo_text', 'ping', 'weather_get_weather']);
  const echo = (await c.listTools()).tools.find((t) => t.name === 'echo_text')!;
  assert.equal((echo.inputSchema.properties as Record<string, { description?: string }>).text?.description, 'Text to repeat');
  await c.close();
});

test('custom plugin tools run with validated input and the caller role', async () => {
  const c = await connect(adminKey);
  assert.equal(textOf(await c.callTool({ name: 'echo_text', arguments: { text: 'hi', times: 2 } })), 'hi hi (admin)');
  const bad = await c.callTool({ name: 'echo_text', arguments: { text: '' } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /^\[invalid_input\]/);
  const fail = await c.callTool({ name: 'echo_fail', arguments: {} });
  assert.equal(fail.isError, true);
  assert.equal(textOf(fail), '[error] expected failure');
  assert.deepEqual(JSON.parse(textOf(await c.callTool({ name: 'echo_count', arguments: {} }))), { n: 1, by: 'admin@acme.com' });
  assert.deepEqual(JSON.parse(textOf(await c.callTool({ name: 'echo_count', arguments: {} }))), { n: 2, by: 'admin@acme.com' });
  await c.close();
});

test('the gateway forwards read tools and blocks write tools', async () => {
  const c = await connect(adminKey);
  assert.equal(textOf(await c.callTool({ name: 'weather_get_weather', arguments: { city: 'Seoul' } })), 'sunny in Seoul');
  const blocked = await c.callTool({ name: 'weather_delete_everything', arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /^\[forbidden\]/);
  await c.close();
});

test('member with allowed_tools=[weather] sees only that group', async () => {
  const c = await connect(memberKey);
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ['ping', 'weather_get_weather']);
  const denied = await c.callTool({ name: 'echo_text', arguments: { text: 'x' } });
  assert.match(textOf(denied), /^\[forbidden\]/);
  await c.close();
});

test('unregistered email is a viewer: ping plus config access.viewerTools', async () => {
  const c = await connect(viewerKey);
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ['echo_count', 'echo_fail', 'echo_text', 'ping']);
  assert.equal(textOf(await c.callTool({ name: 'echo_text', arguments: { text: 'v' } })), 'v (viewer)');
  const ping = JSON.parse(textOf(await c.callTool({ name: 'ping', arguments: {} })));
  assert.equal(ping.role, 'viewer');
  assert.equal(ping.upstreams, undefined); // admin-only detail
  await c.close();
});

test('act-as: a proxy acting for an admin is capped at member', async () => {
  const c = await connect(proxy.key, { 'X-MCP-Act-As-Email': 'admin@acme.com' });
  const ping = JSON.parse(textOf(await c.callTool({ name: 'ping', arguments: {} })));
  assert.equal(ping.authenticated_as, 'admin@acme.com');
  assert.equal(ping.role, 'member');
  await c.close();
  const anon = await connect(proxy.key); // no header → viewer
  assert.equal(JSON.parse(textOf(await anon.callTool({ name: 'ping', arguments: {} }))).role, 'viewer');
  await anon.close();
});

test('every call is in the audit log', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(process.env.MCP_DATA_DIR!, 'knowledge-mcp.db'));
  await new Promise((r) => setTimeout(r, 100)); // logging is fire-and-forget
  const rows = db.prepare("select tool, ok from mcp_tool_calls where tool = 'echo_fail'").all();
  assert.ok(rows.length >= 1);
  assert.equal(rows[0]!.ok, 0);
  db.close();
});
