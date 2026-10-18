/** Generator unit tests: names, package-manager detection, and what scaffold() writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, scaffold, toPackageName } from '../index.js';

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
