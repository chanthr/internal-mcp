/** Command hints must be typed the way they work where the person is: npm scripts in a project, npx, or the binary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from '../src/core/invocation.js';

function project(scripts: Record<string, string>): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-inv-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }));
  return { npm_command: 'run-script', npm_package_json: join(dir, 'package.json') };
}

test('in a generated project the hint is an npm script', () => {
  const env = project({
    dev: 'tsx watch --include src/plugins src/server.ts serve',
    setup: 'tsx src/server.ts setup',
    doctor: 'tsx src/server.ts doctor',
    keys: 'tsx src/server.ts keys',
    knowledge: 'tsx src/server.ts knowledge',
    mcp: 'tsx src/server.ts',
    test: 'vitest',
  });
  assert.equal(cli('setup check', env), 'npm run setup -- check');
  assert.equal(cli('setup', env), 'npm run setup');
  assert.equal(cli('doctor', env), 'npm run doctor');
  assert.equal(cli('serve', env), 'npm run dev');
  assert.equal(cli('keys create --email you@example.com --role admin', env), 'npm run keys -- create --email you@example.com --role admin');
  assert.equal(cli('knowledge scan', env), 'npm run knowledge -- scan');
  assert.equal(cli('shop tables', env), 'npm run mcp -- shop tables'); // no script of its own: the pass-through one
  assert.equal(cli('test', env), 'npm run mcp -- test'); // a script with that name that does not start this program is not used
});

test('a project without those scripts, npx, and the plain binary', () => {
  assert.equal(cli('setup check', project({ start: 'node dist/server.js serve' })), 'npx knowledge-mcp setup check');
  assert.equal(cli('setup check', project({ build: 'tsc' })), 'npx knowledge-mcp setup check');
  assert.equal(cli('setup check', { npm_command: 'exec' }), 'npx @chnxthr/knowledge-mcp setup check');
  assert.equal(cli('setup check', {}), 'knowledge-mcp setup check'); // the Docker image, a global install
  assert.equal(cli('doctor', { npm_command: 'run-script', npm_package_json: '/nonexistent/package.json' }), 'knowledge-mcp doctor');
});
