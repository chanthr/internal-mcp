/**
 * Turning on sign-in for connectors from the console: the public address becomes the OAuth issuer, a signing secret
 * is made once and kept, an address that is not https is refused, and turning it off removes the address only.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_|MCP_OAUTH|OAUTH_|MCP_RESOURCE)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-connectors-'));
mkdirSync(join(dir, 'docs'));
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: join(dir, 'docs'), name: 'docs' }] }));
writeFileSync(join(dir, '.env'), '');
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: join(dir, '.env'),
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
});

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const server = await runHttp(new Registry(builtinPlugins));
after(() => server.close());
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${server.port}/console/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${consoleToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const env = () => readFileSync(join(dir, '.env'), 'utf8');

test('off until there is an address; the state names no secret', async () => {
  const s = await api('GET', '/state');
  assert.deepEqual(s.json.connectors, { on: false, address: null, google: false, googleMissing: [] });
});

test('turning it on writes the address and makes a secret once; http is refused', async () => {
  assert.equal((await api('POST', '/connectors', { address: 'http://mcp.example.com' })).status, 400);
  const on = await api('POST', '/connectors', { address: 'https://mcp.example.com/some/path' });
  assert.equal(on.status, 200);
  assert.match(on.json.note, /https:\/\/mcp\.example\.com\/mcp/);
  assert.match(env(), /^MCP_OAUTH_ISSUER=https:\/\/mcp\.example\.com$/m);
  const secret = /^OAUTH_JWT_SECRET=(.+)$/m.exec(env())?.[1] ?? '';
  assert.ok(secret.length >= 40);

  // Again with another address: the secret stays, so tokens given out keep working.
  process.env.OAUTH_JWT_SECRET = secret;
  await api('POST', '/connectors', { address: 'https://other.example.com' });
  assert.match(env(), /^MCP_OAUTH_ISSUER=https:\/\/other\.example\.com$/m);
  assert.equal(/^OAUTH_JWT_SECRET=(.+)$/m.exec(env())?.[1], secret);

  // Off: the address goes, the secret stays.
  await api('DELETE', '/connectors');
  assert.doesNotMatch(env(), /^MCP_OAUTH_ISSUER=/m);
  assert.match(env(), /OAUTH_JWT_SECRET=/);
});
