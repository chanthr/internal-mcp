/**
 * Which folder's .env and mcp.config.json the server reads, and where a relative MCP_DATA_DIR points.
 *
 * An AI client starts a stdio server in the folder the person has open, which may be anybody's repository. A .env
 * or mcp.config.json there must not decide where documents are sent, where the index is kept, or what is
 * configured. Each case starts a small program the way a client starts the server: its file is in a project folder
 * (the app root), and the working directory is somewhere else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TSX = import.meta.resolve('tsx');
const src = (file: string) => pathToFileURL(fileURLToPath(new URL(`../src/${file}`, import.meta.url))).href;
// Real paths: the app root is found from the real path of the program, and macOS's temporary folder is a link.
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kmcp-${name}-`)));

/** A folder with a program in it that loads the settings as the server does and prints what it ended up with. */
function project(files: Record<string, string> = {}): { dir: string; entry: string } {
  const dir = folder('project');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-mcp', private: true, type: 'module' }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const entry = join(dir, 'probe.mts');
  writeFileSync(
    entry,
    [
      `await import(${JSON.stringify(src('bootstrap.ts'))});`,
      `const { dataDir } = await import(${JSON.stringify(src('core/paths.ts'))});`,
      `const { getConfig, settingsDir } = await import(${JSON.stringify(src('core/config.ts'))});`,
      'console.log(JSON.stringify({ base: process.env.EMBEDDING_BASE_URL ?? null, org: getConfig().orgId, data: dataDir(), settings: settingsDir() }));',
    ].join('\n'),
  );
  return { dir, entry };
}

/** Somebody else's repository: settings that would send the documents elsewhere and keep the index inside it. */
function repository(): string {
  const dir = folder('repo');
  writeFileSync(join(dir, '.env'), 'EMBEDDING_BASE_URL=https://collector.example.com/v1\nMCP_DATA_DIR=./.cache-x\n');
  writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ orgId: 'theirs' }));
  return dir;
}

function probe(entry: string, cwd: string, extra: Record<string, string> = {}): { base: string | null; org: string; data: string; settings: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(MCP_|EMBEDDING_|OPENAI_|QDRANT_|LLM_|GOOGLE_)/.test(k)) env[k] = v;
  const r = spawnSync(process.execPath, ['--import', TSX, entry], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

const mine = { '.env': 'EMBEDDING_BASE_URL=https://embeddings.example.org/v1\nMCP_DATA_DIR=./index\n', 'mcp.config.json': JSON.stringify({ orgId: 'mine' }) };

test('a project entry started in another repository reads the project, not the repository', () => {
  // An entry written before entries carried MCP_HOME: the app root is found from the program's own path.
  const { dir, entry } = project(mine);
  const repo = repository();
  assert.deepEqual(probe(entry, repo), { base: 'https://embeddings.example.org/v1', org: 'mine', data: join(dir, 'index'), settings: dir });
});

test('with MCP_HOME the working directory is never read, even when the named folder has no settings', () => {
  const { dir, entry } = project(mine);
  const repo = repository();
  assert.deepEqual(probe(entry, repo, { MCP_HOME: dir }), { base: 'https://embeddings.example.org/v1', org: 'mine', data: join(dir, 'index'), settings: dir });
  const empty = folder('home');
  const r = probe(project().entry, repo, { MCP_HOME: empty });
  assert.deepEqual([r.base, r.org === 'theirs', r.data, r.settings], [null, false, join(empty, 'data'), empty]);
  // A relative MCP_DATA_DIR or MCP_CONFIG_PATH is inside the named folder, not the working directory.
  assert.equal(probe(entry, repo, { MCP_HOME: dir, MCP_DATA_DIR: 'kept' }).data, join(dir, 'kept'));
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ orgId: 'other' }));
  writeFileSync(join(repo, 'other.json'), JSON.stringify({ orgId: 'theirs' }));
  assert.deepEqual(probe(entry, repo, { MCP_HOME: dir, MCP_CONFIG_PATH: 'other.json' }).org, 'other');
});

test('without MCP_HOME, a folder whose app root has no settings still reads the working directory', () => {
  // Someone runs the program inside their own folder of settings: that keeps working.
  const { dir: root, entry } = project();
  const own = folder('own');
  writeFileSync(join(own, '.env'), 'EMBEDDING_BASE_URL=https://embeddings.example.org/v1\nMCP_DATA_DIR=./index\n');
  writeFileSync(join(own, 'mcp.config.json'), JSON.stringify({ orgId: 'mine' }));
  assert.deepEqual(probe(entry, own), { base: 'https://embeddings.example.org/v1', org: 'mine', data: join(own, 'index'), settings: own });
  // Either file in the app root makes it the settings folder: the working directory is then not read at all.
  writeFileSync(join(root, 'mcp.config.json'), JSON.stringify({ orgId: 'root' }));
  assert.deepEqual(probe(entry, own), { base: null, org: 'root', data: join(root, 'data'), settings: root });
});
