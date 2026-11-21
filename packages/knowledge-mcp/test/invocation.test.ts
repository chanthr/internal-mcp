/** Command hints must be typed the way they work where the person is, and the entries clients start this server with. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, installCommandLine, installPackage, stdioEntry } from '../src/core/invocation.js';
import { VERSION } from '../src/version.js';

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

  // No project: Node and this package's cli.js, never npx. Run from source (as here) or from npx's cache, this copy
  // is not one an entry may point at, so a copy of this version is installed into the folder first.
  const bare = mkdtempSync(join(tmpdir(), 'kmcp-bare-'));
  const copy = join(bare, 'node_modules', '@chnxthr', 'knowledge-mcp', 'dist', 'cli.js');
  const install = { spec: `@chnxthr/knowledge-mcp@${VERSION}`, prefix: bare };
  assert.deepEqual(stdioEntry(bare, node, 'darwin', null), { command: node, args: [copy, 'serve', '--stdio'], env: { MCP_HOME: bare }, install });
  assert.deepEqual(stdioEntry(bare, 'C:\\nodejs\\node.exe', 'win32', null).command, 'C:\\nodejs\\node.exe');
  assert.equal(installCommandLine(install), `npm install --prefix ${bare} --save-exact --ignore-scripts --no-audit --no-fund @chnxthr/knowledge-mcp@${VERSION}`);
  // A built copy that stays where it is (a global install) is run where it is.
  assert.deepEqual(stdioEntry(bare, node, 'darwin', '/opt/lib/node_modules/@chnxthr/knowledge-mcp/dist/cli.js'), { command: node, args: ['/opt/lib/node_modules/@chnxthr/knowledge-mcp/dist/cli.js', 'serve', '--stdio'], env: { MCP_HOME: bare } });
  // The folder's own copy is used when it is this version; another version is replaced by this one.
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, '');
  writeFileSync(join(dirname(copy), '..', 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', version: '0.0.1' }));
  assert.deepEqual(stdioEntry(bare, node, 'darwin', null).install, install);
  writeFileSync(join(dirname(copy), '..', 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', version: VERSION }));
  assert.deepEqual(stdioEntry(bare, node, 'darwin', '/opt/elsewhere/dist/cli.js'), { command: node, args: [copy, 'serve', '--stdio'], env: { MCP_HOME: bare } });

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


test('without a project the entry is Node and a pinned copy in the settings folder: nothing of the opened repository runs (real npm, local registry)', async (t) => {
  const node = realpathSync(process.execPath);
  const bin = dirname(node);
  if (process.platform === 'win32' || !existsSync(join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))) return t.skip('needs npm beside node');
  const made = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kmcp-pin-${name}-`)));

  // A stand-in for the package, with the same bin and shebang, that says which Node ran it and with what.
  const pack = made('pack');
  mkdirSync(join(pack, 'package', 'dist'), { recursive: true });
  writeFileSync(join(pack, 'package', 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', version: VERSION, bin: { 'knowledge-mcp': 'dist/cli.js' } }));
  writeFileSync(join(pack, 'package', 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ran: "the package", node: process.execPath, args: process.argv.slice(2), home: process.env.MCP_HOME }));\n', { mode: 0o755 });
  const tgz = join(pack, 'package.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', pack, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0);
  const tarball = readFileSync(tgz);

  // Two registries on this machine: the person's, and the one the repository's .npmrc names.
  const asked: string[] = [];
  const registry = (who: string, serve: boolean) =>
    new Promise<Server>((done) => {
      const s = createServer((req, res) => {
        asked.push(`${who} ${req.method} ${decodeURIComponent(req.url ?? '')}`);
        const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
        if (serve && req.url === '/package.tgz') return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tarball);
        if (serve && decodeURIComponent(req.url ?? '') === '/@chnxthr/knowledge-mcp') {
          const dist = { tarball: `${base}/package.tgz`, shasum: createHash('sha1').update(tarball).digest('hex'), integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` };
          const version = { name: '@chnxthr/knowledge-mcp', version: VERSION, bin: { 'knowledge-mcp': 'dist/cli.js' }, dist };
          return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: '@chnxthr/knowledge-mcp', 'dist-tags': { latest: VERSION }, versions: { [VERSION]: version } }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      });
      s.listen(0, '127.0.0.1', () => done(s));
    });
  const mine = await registry('mine', true);
  const theirs = await registry('theirs', false);
  t.after(() => {
    mine.close();
    theirs.close();
  });
  const port = (s: Server) => (s.address() as AddressInfo).port;

  // npm's settings are this test's own: an empty home whose .npmrc names the person's registry. Any address that is
  // not on this machine would go to a proxy that is not there.
  const home = made('home');
  writeFileSync(join(home, '.npmrc'), `registry=http://127.0.0.1:${port(mine)}/\nupdate-notifier=false\naudit=false\nfund=false\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };

  // Adding the entry installs the copy it runs: this version, from the person's registry, into the settings folder.
  const settings = made('settings');
  const first = stdioEntry(settings, node, process.platform, null);
  assert.ok(first.install);
  const installed = await installPackage(first.install, { node, env });
  assert.ok(installed.ok, installed.output);
  assert.ok(asked.length > 0 && asked.every((a) => a.startsWith('mine ')), asked.join(', '));
  const entry = stdioEntry(settings, node, process.platform, null);
  assert.deepEqual([entry.command, entry.args, entry.install], [first.command, first.args, undefined]);
  assert.ok(!JSON.stringify(entry).includes('npx'));

  // The repository the client has open: every shape that ran in place of the server through npx.
  const repo = made('repo');
  const evil = (file: string, what: string) => writeFileSync(file, `#!/bin/sh\necho "EVIL: ${what} of the opened repository ran" >&2\n`, { mode: 0o755 });
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  for (const name of ['node', 'sh', 'knowledge-mcp']) evil(join(repo, 'node_modules', '.bin', name), `node_modules/.bin/${name}`);
  const copy = join(repo, 'node_modules', '@chnxthr', 'knowledge-mcp');
  mkdirSync(join(copy, 'dist'), { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', version: VERSION, bin: { 'knowledge-mcp': 'dist/cli.js' } }));
  writeFileSync(join(copy, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.error("EVIL: the repository\'s copy ran");\n');
  evil(join(repo, 'evil-shell'), 'script-shell');
  writeFileSync(join(repo, 'evil.cjs'), 'console.error("EVIL: node-options from the repository");\n');
  writeFileSync(join(repo, '.npmrc'), `registry=http://127.0.0.1:${port(theirs)}/\nscript-shell=${join(repo, 'evil-shell')}\nnode-options=--require ${join(repo, 'evil.cjs')}\n`);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'some-repo', private: true, dependencies: { '@chnxthr/knowledge-mcp': '*' } }));

  // Started the way a client starts it, in the repository, with the worst PATH: its node_modules/.bin first.
  const r = spawnSync(entry.command, entry.args, { cwd: repo, env: { PATH: `${join(repo, 'node_modules', '.bin')}:${bin}:/usr/bin:/bin`, HOME: home, ...entry.env }, encoding: 'utf8', timeout: 60_000 });
  assert.ok(!`${r.stdout}${r.stderr}`.includes('EVIL'), `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { ran: 'the package', node, args: ['serve', '--stdio'], home: settings });
  assert.ok(!asked.some((a) => a.startsWith('theirs ')), asked.join(', '));
});
