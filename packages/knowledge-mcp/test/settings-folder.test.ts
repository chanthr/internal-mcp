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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TSX = import.meta.resolve('tsx');
const src = (file: string) => pathToFileURL(fileURLToPath(new URL(`../src/${file}`, import.meta.url))).href;
// Real paths: the app root is found from the real path of the program, and macOS's temporary folder is a link.
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kmcp-${name}-`)));

/**
 * A folder with a program in it that loads the settings as the server does and prints what it ended up with: the
 * embedding address, the config's orgId, the data directory, the settings folder and the Drive account.
 * `npx`: the program sits inside node_modules, as when npx starts the server from its cache (no app root then).
 */
function project(files: Record<string, string> = {}, o: { npx?: boolean } = {}): { dir: string; entry: string } {
  let dir = folder('project');
  if (o.npx) {
    dir = join(dir, 'node_modules', '@chnxthr', 'knowledge-mcp');
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-mcp', private: true, type: 'module' }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const entry = join(dir, 'probe.mts');
  writeFileSync(
    entry,
    [
      `await import(${JSON.stringify(src('bootstrap.ts'))});`,
      `const { dataDir } = await import(${JSON.stringify(src('core/paths.ts'))});`,
      `const { getConfig, settingsDir } = await import(${JSON.stringify(src('core/config.ts'))});`,
      'let drive = null;',
      `try { const c = (await import(${JSON.stringify(src('plugins/drive/client.ts'))})).resolveCredentials(); drive = c.clientEmail ?? c.kind; } catch {}`,
      'console.log(JSON.stringify({ base: process.env.EMBEDDING_BASE_URL ?? null, org: getConfig().orgId, data: dataDir(), settings: settingsDir(), drive }));',
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

/** Start the program in `cwd`, as a client would, with `args` after it. */
function start(entry: string, cwd: string, extra: Record<string, string> = {}, args: string[] = []) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(MCP_|EMBEDDING_|OPENAI_|QDRANT_|LLM_|GOOGLE_|KMCP_)/.test(k)) env[k] = v;
  return spawnSync(process.execPath, ['--import', TSX, entry, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
}

function probe(entry: string, cwd: string, extra: Record<string, string> = {}, args: string[] = []): { base: string | null; org: string; data: string; settings: string; drive: string | null } {
  const r = start(entry, cwd, extra, args);
  assert.equal(r.status, 0, r.stderr);
  const { drive, ...rest } = JSON.parse(r.stdout.trim().split('\n').pop()!);
  return drive === null ? rest : { ...rest, drive };
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

test('MCP_HOME as people write it: a leading ~ is the home directory, a relative or missing folder stops the server', () => {
  const repo = repository();
  const { entry } = project();
  // The repository holds a folder literally named "~": `-e MCP_HOME=~/kmcp` in zsh, and any JSON config, pass the ~ as is.
  mkdirSync(join(repo, '~', 'kmcp'), { recursive: true });
  writeFileSync(join(repo, '~', 'kmcp', '.env'), 'EMBEDDING_BASE_URL=https://collector.example.com/v1\n');
  const personal = folder('home');
  mkdirSync(join(personal, 'kmcp'));
  for (const [name, text] of Object.entries(mine)) writeFileSync(join(personal, 'kmcp', name), text);
  assert.deepEqual(probe(entry, repo, { HOME: personal, MCP_HOME: '~/kmcp' }), { base: 'https://embeddings.example.org/v1', org: 'mine', data: join(personal, 'kmcp', 'index'), settings: join(personal, 'kmcp') });

  // A relative folder would be found in whichever folder the client starts the server in: refused, nothing read.
  writeFileSync(join(repo, 'kmcp'), '');
  for (const value of ['kmcp', './kmcp', '~kmcp']) {
    const r = start(entry, repo, { MCP_HOME: value });
    assert.deepEqual([r.status, r.stdout], [1, ''], r.stderr);
    assert.match(r.stderr, /MCP_HOME must be a full path/);
  }
  const missing = start(entry, repo, { MCP_HOME: join(personal, 'nope') });
  assert.deepEqual([missing.status, missing.stdout], [1, '']);
  assert.match(missing.stderr, /MCP_HOME points to a folder that does not exist/);
});

test('a relative MCP_ENV_FILE is in the settings folder, not the working directory', () => {
  const { dir, entry } = project(mine);
  const repo = repository();
  writeFileSync(join(dir, 'chosen.env'), 'EMBEDDING_BASE_URL=https://chosen.example.org/v1\n');
  writeFileSync(join(repo, 'chosen.env'), 'EMBEDDING_BASE_URL=https://collector.example.com/v1\n');
  assert.equal(probe(entry, repo, { MCP_HOME: dir, MCP_ENV_FILE: 'chosen.env' }).base, 'https://chosen.example.org/v1');
  assert.equal(probe(entry, repo, { MCP_ENV_FILE: 'chosen.env' }).base, 'https://chosen.example.org/v1'); // the app root
  const r = start(entry, repo, { MCP_HOME: dir, MCP_ENV_FILE: 'other.env' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`MCP_ENV_FILE points to a file that does not exist: ${join(dir, 'other.env')}`), r.stderr);
});

test('a stdio server without MCP_HOME does not start when its settings would be the working directory\'s', () => {
  const repo = repository();
  const refused = (entry: string, cwd: string, extra: Record<string, string>, args: string[]) => {
    const r = start(entry, cwd, extra, args);
    // Stopped before .env is read, with nothing on stdout, where the protocol would be.
    assert.deepEqual([r.status, r.stdout], [1, ''], r.stderr);
    assert.match(r.stderr, /needs MCP_HOME, the full path of the folder with your \.env/);
  };
  // Through npx the program lives in npm's cache, so the working directory is all there is: an entry written by hand.
  const viaNpx = project({}, { npx: true });
  refused(viaNpx.entry, repo, {}, ['serve', '--stdio']);
  refused(viaNpx.entry, repo, {}, ['--stdio']);
  refused(viaNpx.entry, repo, { MCP_TRANSPORT: 'stdio' }, ['serve']);
  refused(viaNpx.entry, repo, { MCP_TRANSPORT: 'stdio' }, []);
  // A project without settings of its own, started in the repository.
  refused(project().entry, repo, {}, ['serve', '--stdio']);

  // With MCP_HOME it starts on that folder's settings.
  const { dir } = project(mine);
  assert.deepEqual(probe(viaNpx.entry, repo, { MCP_HOME: dir }, ['serve', '--stdio']), { base: 'https://embeddings.example.org/v1', org: 'mine', data: join(dir, 'index'), settings: dir });
  // A project with settings of its own needs nothing more (entries written before MCP_HOME), and neither does a
  // project started in its own folder (the Docker image runs in /app).
  const own = project(mine);
  assert.equal(probe(own.entry, repo, {}, ['serve', '--stdio']).org, 'mine');
  const bare = project();
  assert.equal(probe(bare.entry, bare.dir, {}, ['serve', '--stdio']).settings, bare.dir);
  // HTTP and the other commands keep the lookup: a person who runs them in a folder chose that folder.
  assert.equal(probe(viaNpx.entry, repo, {}, ['serve']).org, 'theirs');
  assert.equal(probe(viaNpx.entry, repo, {}, ['doctor']).org, 'theirs');
});

test('a stdio server is refused too when the working directory\'s own .env is what asks for stdio', () => {
  // `serve` with no flag, and MCP_TRANSPORT=stdio in the repository's .env: only run() can see that, after the file.
  const repo = repository();
  writeFileSync(join(repo, '.env'), 'MCP_TRANSPORT=stdio\nEMBEDDING_BASE_URL=https://collector.example.com/v1\n');
  const dir = join(folder('npx'), 'node_modules', '@chnxthr', 'knowledge-mcp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@chnxthr/knowledge-mcp', private: true, type: 'module' }));
  writeFileSync(join(dir, 'server.mts'), `const { run } = await import(${JSON.stringify(src('index.ts'))});\nawait run();\n`);
  const r = start(join(dir, 'server.mts'), repo, { KMCP_SUPERVISE: 'false', MCP_DATA_DIR: join(folder('data'), 'data') }, ['serve']);
  assert.deepEqual([r.status, r.stdout], [1, ''], r.stderr);
  assert.match(r.stderr, /needs MCP_HOME/);
});

test('a relative GOOGLE_APPLICATION_CREDENTIALS is the settings folder\'s file, not the working directory\'s', () => {
  // A repository holding a key file of the same name would otherwise become the Drive account (and its token_uri
  // the address the signed request goes to).
  const repo = repository();
  const key = (email: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: 'x' });
  writeFileSync(join(repo, 'google-service-account.json'), key('them@other.iam.gserviceaccount.com'));
  const files = { ...mine, '.env': `${mine['.env']}GOOGLE_APPLICATION_CREDENTIALS=./google-service-account.json\n`, 'google-service-account.json': key('me@mine.iam.gserviceaccount.com') };
  const { dir, entry } = project(files);
  assert.equal(probe(entry, repo).drive, 'me@mine.iam.gserviceaccount.com'); // the app root
  assert.equal(probe(project().entry, repo, { MCP_HOME: dir }).drive, 'me@mine.iam.gserviceaccount.com');
});

test('settings in the working directory that are not read are named, once, on stderr', () => {
  const { dir: root, entry } = project(mine);
  const own = folder('own');
  writeFileSync(join(own, '.env'), 'EMBEDDING_BASE_URL=https://other.example.org/v1\n');
  const r = start(entry, own);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), `[knowledge-mcp] Using the settings in ${root}, not the .env in this folder. To use this folder, set MCP_HOME=${own}`);
  assert.equal(JSON.parse(r.stdout.trim()).base, 'https://embeddings.example.org/v1');
  // Not said when this folder is chosen, when the files are the ones read, or by a stdio server (whose folder is the
  // client's choice, and stdout is its protocol).
  assert.equal(start(entry, own, { MCP_HOME: own }).stderr, '');
  assert.equal(start(entry, root).stderr, '');
  const stdio = start(entry, own, {}, ['serve', '--stdio']);
  assert.deepEqual([stdio.status, stdio.stderr, stdio.stdout.trim().split('\n').length], [0, '', 1]);
});

test('a stdio server takes no program from the opened repository: its folders and relative entries leave the PATH', async () => {
  const { pathForStdio } = await import('../src/core/paths.js');
  const path = ['/x/repo/node_modules/.bin', '/x/repo', '.', '', '/usr/bin', 'relative/bin', '/home/me/.local/bin', '/x/repo-other/bin'].join(':');
  const kept = (cwd: string) => pathForStdio(path, { cwd, settings: '/home/me/kmcp', home: '/home/me' }).split(':');
  assert.deepEqual(kept('/x/repo'), ['/usr/bin', '/home/me/.local/bin', '/x/repo-other/bin']);
  // Started in the settings folder, in the home folder, or in / (as Claude Desktop does), the folders below are the
  // person's own: only the relative entries go.
  for (const cwd of ['/home/me/kmcp', '/home/me', '/']) assert.deepEqual(kept(cwd), ['/x/repo/node_modules/.bin', '/x/repo', '/usr/bin', '/home/me/.local/bin', '/x/repo-other/bin']);

  // The server itself, started over stdio in a repository whose node_modules/.bin a client put first on the PATH.
  const repo = repository();
  const { dir } = project(mine);
  const entry = join(dir, 'path.mts');
  writeFileSync(entry, `await import(${JSON.stringify(src('bootstrap.ts'))});\nconsole.log(process.env.PATH);\n`);
  const bin = join(repo, 'node_modules', '.bin');
  const r = start(entry, repo, { MCP_HOME: dir, PATH: [bin, '.', process.env.PATH].join(':') }, ['serve', '--stdio']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim(), pathForStdio(process.env.PATH ?? '', { cwd: repo, settings: dir, home: '/nowhere' }));
  assert.ok(!r.stdout.includes(bin));
  // HTTP and the other commands are started by the person, in a folder they chose: the PATH is left as it is.
  assert.equal(start(entry, repo, { MCP_HOME: dir, PATH: [bin, process.env.PATH].join(':') }, ['doctor']).stdout.trim(), [bin, process.env.PATH].join(':'));
});
