#!/usr/bin/env node
/**
 * create-knowledge-mcp — scaffolds your own Knowledge MCP server.
 *
 *   npx create-knowledge-mcp my-mcp            # or: npm create knowledge-mcp@latest my-mcp
 *   npx create-knowledge-mcp my-mcp --no-install --no-git
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
  const opts = { dir: undefined, install: true, git: true, help: false };
  for (const a of argv) {
    if (a === '--no-install') opts.install = false;
    else if (a === '--no-git') opts.git = false;
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
  for (const f of ['package.json', 'README.md']) fill(join(target, f), vars);
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
    console.log(`Usage: npx create-knowledge-mcp [dir] [--no-install] [--no-git]`);
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
  if (opts.install) {
    console.log(dim(`\n${pm} install …`));
    if (!run(pm, ['install'], target)) console.log(`\n${pm} install failed — run it yourself inside ${dir}.`);
  }
  if (opts.git && !existsSync(join(target, '.git'))) {
    spawnSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });
  }

  const runScript = pm === 'npm' ? 'npm run' : pm;
  const tsx = join(target, 'node_modules', '.bin', 'tsx');
  console.log(`
${bold('Next')}
  cd ${dir}
  ${runScript} dev                                  ${dim('# http://localhost:8080/mcp, reloads on save')}
  ${runScript} keys -- create --email you@example.com --role admin   ${dim('# prints an API key once')}

${bold('Add a tool')}
  Copy src/plugins/notes.ts to src/plugins/<name>.ts and edit it. Every file there is loaded.

${bold('Use it from Claude Code (local, no key needed)')}
  claude mcp add ${name} -- ${tsx} ${join(target, 'src', 'server.ts')} serve --stdio

${bold('Check what is on')}
  ${runScript} doctor
`);
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
