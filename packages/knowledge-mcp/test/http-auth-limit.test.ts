/**
 * The limit on failed sign-ins at /mcp: a run of bad keys from one address is stopped, and clients that signed in
 * are never counted toward it, however long their SSE streams stay open.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) {
  if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|MCP_OAUTH|OAUTH_|MCP_RATE_LIMIT|KNOWLEDGE_)/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-limit-')),
  MCP_STORE: 'sqlite',
  MCP_ENV_FILE: 'none',
  MCP_CONFIG_JSON: JSON.stringify({ orgId: 'acme' }),
  KMCP_SUPERVISE: 'false',
  PORT: '0',
  TRUST_PROXY: 'false',
  MCP_RATE_LIMIT_FAIL_MAX: '3',
});

const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/sdk/types.js');
const { getStore } = await import('../src/store/index.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { runHttp } = await import('../src/server/http.js');

const store = await getStore();
await store.upsertUser({ email: 'member@acme.com', role: 'member' });
const key = (await store.createKey({ email: 'member@acme.com', orgId: 'acme' })).key;
const server = await runHttp(new Registry(builtinPlugins));
const base = `http://127.0.0.1:${server.port}/mcp`;
const streams: AbortController[] = [];
after(async () => {
  for (const s of streams) s.abort();
  await server.close();
});

const post = (bearer: string, body: unknown) =>
  fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

/** A client as a connector is: a session, and the SSE stream it keeps open for what the server sends. */
async function openStream(): Promise<number> {
  const init = await post(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
  await init.text();
  if (init.status !== 200) return init.status;
  const stop = new AbortController();
  streams.push(stop);
  const stream = await fetch(base, { headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream', 'Mcp-Session-Id': init.headers.get('mcp-session-id')!, 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }, signal: stop.signal });
  return stream.status;
}

test('open SSE streams of clients that signed in do not count as failed sign-ins', async () => {
  // More clients behind one address (an office) than the limit allows failures: each keeps its stream open.
  for (let i = 0; i < 5; i++) assert.equal(await openStream(), 200, `client ${i + 1}`);
  for (const s of streams.splice(0)) s.abort();
});

test('a run of bad keys from one address is still stopped', async () => {
  const bad = () => post('kmcp_wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' }).then(async (r) => (await r.text(), r.status));
  assert.deepEqual([await bad(), await bad(), await bad()], [401, 401, 401]);
  const stopped = await post('kmcp_wrong', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(stopped.status, 429);
  assert.match(await stopped.text(), /too many failed auth attempts/);
});
