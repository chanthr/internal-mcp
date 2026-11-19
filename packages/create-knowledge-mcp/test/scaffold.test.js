/** Generator unit tests: names, package-manager detection, and what scaffold() writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectPackageManager, scaffold, shellWord, toPackageName } from '../index.js';

test('folder name becomes a valid package name', () => {
  assert.equal(toPackageName('My MCP'), 'my-mcp');
  assert.equal(toPackageName('./apps/team_tools'), 'team_tools');
  assert.equal(toPackageName('...'), 'my-knowledge-mcp');
});

test('package manager comes from the user agent', () => {
  assert.equal(detectPackageManager('pnpm/9.1.0 npm/? node/v22.13.0 darwin arm64'), 'pnpm');
  assert.equal(detectPackageManager('yarn/4.1.0 npm/? node/v22.13.0'), 'yarn');
  assert.equal(detectPackageManager('npm/10.9.0 node/v22.13.0'), 'npm');
  assert.equal(detectPackageManager(''), 'npm');
});

test('scaffold writes a runnable project with placeholders filled', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'kmcp-create-')), 'team-mcp');
  scaffold(dir, { name: 'team-mcp', coreSpec: '^9.9.9' });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'team-mcp');
  assert.equal(pkg.dependencies['@chnxthr/knowledge-mcp'], '^9.9.9');
  for (const f of ['.gitignore', '.dockerignore', '.env', '.env.example', 'Dockerfile', 'tsconfig.json', 'README.md', 'src/server.ts', 'src/plugins/notes.ts']) {
    assert.ok(existsSync(join(dir, f)), `${f} exists`);
  }
  assert.equal(existsSync(join(dir, '_gitignore')), false);
  assert.doesNotMatch(readFileSync(join(dir, 'README.md'), 'utf8'), /__[A-Z_]+__/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.env$/m);
});

test('a path with a space in it stays one word in the commands that are printed', () => {
  assert.equal(shellWord('/srv/team/my-mcp', 'darwin'), '/srv/team/my-mcp');
  assert.equal(shellWord('/Users/ann/My Projects/my-mcp', 'darwin'), "'/Users/ann/My Projects/my-mcp'");
  assert.equal(shellWord("/srv/ann's/mcp", 'linux'), `'/srv/ann'\\''s/mcp'`);
  assert.equal(shellWord('C:\\Users\\Ann Lee\\mcp', 'win32'), '"C:\\Users\\Ann Lee\\mcp"');
  assert.equal(shellWord('C:\\Users\\ann\\mcp', 'win32'), 'C:\\Users\\ann\\mcp');

  // The generator run in a folder whose name has a space: the line for Claude Code names one path, not two halves,
  // and a shell splits it back into the words that were meant.
  const parent = join(mkdtempSync(join(tmpdir(), 'kmcp-create-')), 'My Projects');
  mkdirSync(parent);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url)), 'team-mcp', '--no-install', '--no-git', '--no-setup'], { cwd: parent, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find((l) => l.includes('claude mcp add'));
  assert.ok(line, run.stdout);
  if (process.platform !== 'win32') {
    const words = spawnSync('sh', ['-c', `printf '%s\\n' ${line.trim()}`], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(words.slice(0, 7), ['claude', 'mcp', 'add', '--scope', 'user', 'team-mcp', '--']);
    assert.equal(words[7], process.execPath);
    assert.ok(words[8].endsWith(join('My Projects', 'team-mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs')), words[8]);
    assert.ok(words[9].endsWith(join('My Projects', 'team-mcp', 'src', 'server.ts')), words[9]);
    assert.deepEqual(words.slice(10), ['serve', '--stdio']);
  }
});
