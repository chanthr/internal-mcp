/** stdio end to end: the client spawns the server like Claude Code would, from another working directory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  env.MCP_ENV_FILE = join(elsewhere, 'missing.env'); // ignore any .env next to the repo
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

test('cli: unknown command exits 2, help exits 0', () => {
  const bad = spawnSync(process.execPath, ['--import', TSX, server, 'frobnicate'], { cwd: elsewhere, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(bad.status, 2);
  const help = spawnSync(process.execPath, ['--import', TSX, server, 'help'], { cwd: elsewhere, env: cleanEnv(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /keys create/);
});
