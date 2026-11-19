/**
 * The computer's own folder chooser, opened from the console: the folder picked is added where it is, closing the
 * chooser adds nothing, and a chooser that cannot be shown says so. The choosers here are stand-ins on PATH, so no
 * window opens on this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-picker-'));
const picked = join(dir, 'handbook');
mkdirSync(picked);
writeFileSync(join(picked, 'leave.md'), '# Leave\n\nAsk three days ahead.\n');
writeFileSync(join(dir, 'mcp.config.json'), '{}');
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
});

// Stand-ins for the choosers of macOS and Linux. What they answer is set per test through a file.
const bin = join(dir, 'bin');
mkdirSync(bin);
const answer = join(dir, 'answer');
const stub = `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "$@" >> "${join(dir, 'calls')}"\n. "${answer}"\n`;
for (const name of ['osascript', 'zenity']) {
  writeFileSync(join(bin, name), stub);
  chmodSync(join(bin, name), 0o755);
}
const answers = (sh: string) => writeFileSync(answer, sh);
const PATH = process.env.PATH;
process.env.PATH = `${bin}:${PATH}`;

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { chooserCommand } = await import('../src/admin/folder_picker.js');

const server = await runHttp(new Registry(builtinPlugins));
const token = consoleToken();
after(async () => {
  process.env.PATH = PATH;
  await server.close();
});
const choose = async () => {
  const res = await fetch(`http://localhost:${server.port}/console/api/folders/choose`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as any };
};
const config = () => JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));

test('each system has its chooser, and none is made up where there is none', async () => {
  const none = async () => ({ status: 1, stdout: '', stderr: '' });
  const mac = await chooserCommand(none, 'darwin');
  assert.equal(mac?.[0], 'osascript');
  assert.match(mac!.join(' '), /activate .*choose folder with prompt/);
  assert.equal((await chooserCommand(none, 'win32'))?.[0], 'powershell');
  assert.equal(await chooserCommand(none, 'linux'), null);
  const zenity = async (cmd: string) => ({ status: cmd === 'zenity' ? 0 : 1, stdout: '', stderr: '' });
  assert.deepEqual((await chooserCommand(zenity, 'linux'))?.slice(0, 3), ['zenity', '--file-selection', '--directory']);
});

test('the folder picked is added where it is', async () => {
  // osascript ends the path with a slash; zenity does not. Either way it is added without one.
  answers(`echo "${picked}/"\n`);
  const r = await choose();
  assert.equal(r.status, 200);
  assert.equal(r.json.path, picked);
  assert.deepEqual(config().folders, [{ path: picked }]);
});

test('closing the chooser adds nothing', async () => {
  answers(`echo "execution error: User canceled. (-128)" >&2\nexit 1\n`);
  const r = await choose();
  assert.deepEqual([r.status, r.json], [200, { canceled: true }]);
  assert.equal(config().folders.length, 1);
});

test('a chooser that cannot be shown says so, and what to do instead', async () => {
  answers(`echo "execution error: No user interaction allowed. (-1713)" >&2\nexit 1\n`);
  const r = await choose();
  assert.ok(r.status >= 400);
  assert.match(r.json.error, /could not be shown \(execution error: No user interaction allowed\. \(-1713\)\)\. Type the folder path instead/);
});

test('the page learns which folder names an upload leaves out', async () => {
  const res = await fetch(`http://localhost:${server.port}/console/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  const state = (await res.json()) as any;
  assert.ok(state.excludedFolders.includes('node_modules'));
  assert.equal(typeof state.folderPicker, 'boolean');
});
