#!/usr/bin/env node
/**
 * create-knowledge-mcp — scaffolds your own Knowledge MCP server.
 *
 *   npx create-knowledge-mcp my-mcp            # or: npm create knowledge-mcp@latest my-mcp
 *   npx create-knowledge-mcp my-mcp --no-install --no-git --no-setup
 *
 * No dependencies: copies ./template, fills in the project name and the framework version, installs
 * packages with the package manager that ran it (npm, pnpm, yarn or bun), and prints the next steps.
 * KMCP_CORE_SPEC overrides the @chnxthr/knowledge-mcp dependency (tests use a local tarball).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TEMPLATE = join(HERE, 'template');
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
const CORE = '@chnxthr/knowledge-mcp';
// npm drops .gitignore from published packages, so the template keeps it as _gitignore.
const RENAMES = { _gitignore: '.gitignore', _dockerignore: '.dockerignore' };

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[39m` : s);

function parseArgs(argv) {
  const opts = { dir: undefined, install: true, git: true, setup: true, help: false };
  for (const a of argv) {
    if (a === '--no-install') opts.install = false;
    else if (a === '--no-git') opts.git = false;
    else if (a === '--no-setup') opts.setup = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!opts.dir) opts.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

/** npm package name rules, simplified: lowercase, url-safe, no leading dot or underscore. */
export function toPackageName(dir) {
  return (
    basename(resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9._~-]+/g, '-')
      .replace(/^[._-]+|[-]+$/g, '') || 'my-knowledge-mcp'
  );
}

/** Which package manager started us (npm_config_user_agent = "pnpm/9.0.0 npm/? node/v22 ..."). */
export function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? '') {
  const name = userAgent.split(' ')[0]?.split('/')[0];
  return ['pnpm', 'yarn', 'bun'].includes(name) ? name : 'npm';
}

function isEmptyDir(path) {
  return !existsSync(path) || readdirSync(path).filter((f) => f !== '.git' && f !== '.DS_Store').length === 0;
}

function fill(path, vars) {
  let s = readFileSync(path, 'utf8');
  for (const [k, v] of Object.entries(vars)) s = s.split(`__${k}__`).join(v);
  writeFileSync(path, s);
}

/** Copy the template into `target` and fill placeholders. Exported for tests. */
export function scaffold(target, { name, coreSpec }) {
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE, target, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) {
    if (existsSync(join(target, from))) renameSync(join(target, from), join(target, to));
  }
  const vars = { NAME: name, CORE_SPEC: coreSpec, VERSION };
  for (const f of ['package.json', 'README.md', 'AGENTS.md', 'CLAUDE.md']) fill(join(target, f), vars);
  if (!existsSync(join(target, '.env'))) cpSync(join(target, '.env.example'), join(target, '.env'));
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${dim(`(${fallback})`)} `)).trim();
    return a || fallback;
  } finally {
    rl.close();
  }
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: npx create-knowledge-mcp [dir] [--no-install] [--no-git] [--no-setup]`);
    return;
  }
  const dir = opts.dir ?? (await ask('Project folder?', 'my-knowledge-mcp'));
  const target = resolve(dir);
  if (!isEmptyDir(target)) throw new Error(`${target} is not empty — pick a new folder`);

  const name = toPackageName(dir);
  const coreSpec = process.env.KMCP_CORE_SPEC || `^${VERSION}`;
  scaffold(target, { name, coreSpec });
  console.log(`\n${green('✓')} Created ${bold(name)} in ${target}`);

  const pm = detectPackageManager();
  let installed = false;
  if (opts.install) {
    console.log(dim(`\n${pm} install …`));
    installed = run(pm, ['install'], target);
    if (!installed) console.log(`\n${pm} install failed — run it yourself inside ${dir}.`);
  }
  if (opts.git && !existsSync(join(target, '.git'))) {
    spawnSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });
  }

  const runScript = pm === 'npm' ? 'npm run' : pm;

  // Go straight into the guided setup, so the project is connected and checked before the first start.
  // Only in a terminal: the setup asks questions.
  if (installed && opts.setup && process.stdin.isTTY && process.stdout.isTTY) {
    const a = (await ask('\nSet it up now (documents, a database, Drive, Slack, GitHub)?', 'Y')).toLowerCase();
    if (a === 'y' || a === 'yes') {
      console.log('');
      run(pm, ['run', 'setup'], target);
    }
  }
  // The line a person pastes into a shell: a path with a space in it ("My Projects/my-mcp") must stay one word,
  // or the client is given half a path to start. Node is named by its full path, so nothing is looked up when a
  // client starts the server from somewhere else. The client starts it in whatever project is open, which may be
  // somebody else's: MCP_HOME names this folder for the settings, and --tsconfig names this project's TypeScript
  // config, since tsx would otherwise read that project's tsconfig.json, whose "paths" can swap the framework's import
  // for a file of theirs.
  const addToClaude = [
    'claude', 'mcp', 'add', '--scope', 'user', name, '-e', `MCP_HOME=${target}`, '--',
    process.execPath, join(target, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', join(target, 'tsconfig.json'), join(target, 'src', 'server.ts'), 'serve', '--stdio',
  ]
    .map(shellWord)
    .join(' ');
  const steps = [
    `  cd ${shellWord(dir)}`,
    ...(installed ? [] : [`  ${pm} install`]),
    `  ${runScript} setup                                ${dim('# asks what to connect, checks it, writes .env. Run it again any time')}`,
    `  ${runScript} dev                                  ${dim('# http://localhost:8080/mcp, restarts when a file or the config changes')}`,
  ];
  console.log(`
${bold('Next')}
${steps.join('\n')}

${bold('Nothing to write')}
  ${runScript} setup -- folder <path>               ${dim('# a folder of documents: searchable right away, no account, no key')}
  ${runScript} setup                                ${dim('# pick Database: questions about a Postgres database or a SQLite file')}

${bold('Let an AI agent set it up')}
  Open this folder in Claude Code (or another agent) and say: "set this server up, follow AGENTS.md"

${bold('Write your own tool')}
  Copy src/plugins/notes.ts to src/plugins/<name>.ts and edit it. Every file there is loaded.

${bold('Use it from an AI client (local, no key needed)')}
  ${runScript} dev                                  ${dim('# then open the console address it prints: Connect a client adds it for you')}
  ${addToClaude}

${bold('Check what is on')}
  ${runScript} doctor
`);
}

/** One word of a command line, quoted when a shell would split or change it. */
export function shellWord(word, platform = process.platform) {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(word) && (platform === 'win32' || !word.includes('\\'))) return word;
  return platform === 'win32' ? `"${word.replace(/"/g, '\\"')}"` : `'${word.replace(/'/g, `'\\''`)}'`;
}

// Run only as a command (npx goes through a bin symlink, hence realpath), not when imported by tests.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`create-knowledge-mcp: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
