/** Command hints must be typed the way they work where the person is: npm scripts in a project, npx, or the binary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, stdioCommand, stdioEntry } from '../src/core/invocation.js';

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

test('the entry for a client names this Node by its full path, so a desktop app needs no PATH of its own', () => {
  const bin = mkdtempSync(join(tmpdir(), 'kmcp-node-'));
  const node = join(bin, 'node');
  writeFileSync(node, '');
  writeFileSync(join(bin, 'npx'), '');

  // No project: npx beside that Node, the folder named outright, and a PATH that holds node (npx is a script).
  const bare = mkdtempSync(join(tmpdir(), 'kmcp-bare-'));
  const viaNpx = stdioEntry(bare, node, 'darwin');
  assert.match(viaNpx.command, /[\\/]npx$/);
  assert.deepEqual(viaNpx.args, ['--prefix', bare, '-y', '@chnxthr/knowledge-mcp', 'serve', '--stdio']);
  assert.equal(viaNpx.env?.MCP_HOME, bare);
  assert.ok(viaNpx.env?.PATH.split(':').some((d) => viaNpx.command.startsWith(d)), 'node is on the PATH the entry sets');
  // Windows starts npx.cmd by its plain name, with the same --prefix.
  assert.deepEqual(stdioEntry(bare, node, 'win32'), { command: 'npx', args: ['--prefix', bare, '-y', '@chnxthr/knowledge-mcp', 'serve', '--stdio'], env: { MCP_HOME: bare } });
  assert.deepEqual(stdioCommand(bare), ['npx', '--prefix', bare, '-y', '@chnxthr/knowledge-mcp', 'serve', '--stdio']);

  // A built project, then one run from source: Node itself with the file to run. The folder is named outright here
  // too: the client starts the server in the project the person has open, whose settings are not this server's.
  const built = mkdtempSync(join(tmpdir(), 'kmcp-built-'));
  mkdirSync(join(built, 'dist'));
  writeFileSync(join(built, 'dist', 'server.js'), '');
  assert.deepEqual(stdioEntry(built, node, 'darwin'), { command: node, args: [join(built, 'dist', 'server.js'), 'serve', '--stdio'], env: { MCP_HOME: built } });
  mkdirSync(join(built, 'src'));
  writeFileSync(join(built, 'src', 'server.ts'), '');
  mkdirSync(join(built, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(built, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  // tsx is told which tsconfig.json is the project's: the null device while it has none, never the working directory's.
  const tsx = join(built, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const own = join(built, 'src', 'server.ts');
  assert.deepEqual(stdioEntry(built, node, 'darwin'), { command: node, args: [tsx, '--tsconfig', '/dev/null', own, 'serve', '--stdio'], env: { MCP_HOME: built } });
  assert.deepEqual(stdioEntry(built, node, 'win32').args, [tsx, '--tsconfig', '\\\\.\\nul', own, 'serve', '--stdio']);
  writeFileSync(join(built, 'tsconfig.json'), '{}');
  assert.deepEqual(stdioEntry(built, node, 'darwin'), { command: node, args: [tsx, '--tsconfig', join(built, 'tsconfig.json'), own, 'serve', '--stdio'], env: { MCP_HOME: built } });
  assert.deepEqual(stdioEntry(built, node, 'win32').env, { MCP_HOME: built });
  // The setup wizard's line runs tsx through node_modules/.bin, with the same flag.
  mkdirSync(join(built, 'node_modules', '.bin'));
  writeFileSync(join(built, 'node_modules', '.bin', 'tsx'), '');
  assert.deepEqual(stdioCommand(built), [join(built, 'node_modules', '.bin', 'tsx'), '--tsconfig', join(built, 'tsconfig.json'), own, 'serve', '--stdio']);
});

// ── What an entry runs when the client starts it in a repository the person has open ──

const tsxPackage = dirname(fileURLToPath(import.meta.resolve('tsx/package.json')));

test('a project entry runs the project\'s own code, whatever tsconfig.json the working directory holds (real tsx)', () => {
  // A project as the generator makes it, with a stand-in for the framework that says it ran.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kmcp-tsx-project-')));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-mcp', private: true, type: 'module' }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'server.ts'), "import { run } from '@chnxthr/knowledge-mcp';\nawait run();\n");
  const framework = join(dir, 'node_modules', '@chnxthr', 'knowledge-mcp');
  mkdirSync(framework, { recursive: true });
  writeFileSync(join(framework, 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', type: 'module', exports: { '.': './index.js' } }));
  writeFileSync(join(framework, 'index.js'), "export const run = async () => console.log('the framework ran');\n");
  symlinkSync(tsxPackage, join(dir, 'node_modules', 'tsx'), 'dir');
  // The repository open in the client: its tsconfig.json maps the framework's import to a file of its own.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kmcp-tsx-repo-')));
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@chnxthr/knowledge-mcp': ['./pwn.ts'] } } }));
  writeFileSync(join(repo, 'pwn.ts'), "export const run = async () => console.log('the repository ran');\n");

  const start = (): string => {
    const entry = stdioEntry(dir);
    const r = spawnSync(entry.command, entry.args, { cwd: repo, env: { ...process.env, ...entry.env }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(start(), 'the framework ran'); // the project has no tsconfig.json: tsx is given none
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true }, include: ['src/**/*'] }));
  assert.equal(start(), 'the framework ran');
});

test('an npx entry takes nothing from the working directory: not its node_modules, not its .npmrc (real npx, local registries)', async (t) => {
  const node = realpathSync(process.execPath);
  if (process.platform === 'win32' || !existsSync(join(dirname(node), 'npx'))) return t.skip('needs npx beside node');
  // Two registries on this machine: the person's (in their own npm settings) and the one the repository names.
  const asked: string[] = [];
  const registry = (who: string) =>
    new Promise<Server>((done) => {
      const s = createServer((req, res) => {
        asked.push(`${who} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      });
      s.listen(0, '127.0.0.1', () => done(s));
    });
  const mine = await registry('mine');
  const theirs = await registry('theirs');
  t.after(() => {
    mine.close();
    theirs.close();
  });
  const port = (s: Server) => (s.address() as AddressInfo).port;

  // The repository: an .npmrc that sends the package to its registry, and a copy of the package of its own.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kmcp-npx-repo-')));
  writeFileSync(join(repo, '.npmrc'), `@chnxthr:registry=http://127.0.0.1:${port(theirs)}/\nregistry=http://127.0.0.1:${port(theirs)}/\n`);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'some-repo', private: true, dependencies: { '@chnxthr/knowledge-mcp': '*' } }));
  const copy = join(repo, 'node_modules', '@chnxthr', 'knowledge-mcp');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', version: '9.9.9', bin: { 'knowledge-mcp': 'cli.js' } }));
  writeFileSync(join(copy, 'cli.js'), "#!/usr/bin/env node\nconsole.log('the repository\\'s copy ran');\n", { mode: 0o755 });
  mkdirSync(join(repo, 'node_modules', '.bin'));
  symlinkSync('../@chnxthr/knowledge-mcp/cli.js', join(repo, 'node_modules', '.bin', 'knowledge-mcp'));

  // npm's own settings are kept to this test: an empty home, a cache of its own, and the person's registry.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kmcp-npx-home-')));
  const settings = realpathSync(mkdtempSync(join(tmpdir(), 'kmcp-npx-settings-')));
  const entry = stdioEntry(settings, node);
  const env = {
    ...entry.env,
    HOME: home,
    npm_config_cache: join(home, 'cache'),
    npm_config_globalconfig: join(home, 'npmrc-global'),
    npm_config_registry: `http://127.0.0.1:${port(mine)}/`,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const output = await new Promise<string>((done) => {
    const child = spawn(entry.command, entry.args, { cwd: repo, env });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const limit = setTimeout(() => child.kill(), 60_000);
    child.on('close', () => {
      clearTimeout(limit);
      done(text);
    });
  });
  assert.ok(!output.includes("the repository's copy ran"), output);
  assert.ok(asked.length > 0 && asked.every((a) => a.startsWith('mine ')), `${asked.join(', ')}\n${output}`);
});
