/**
 * How a person types a command of this program, given how the program itself was started.
 *
 * Messages tell people what to run next ("check it with: … setup check"). The words that work depend on where they
 * are: in a generated project the binary is not on the PATH and the commands are npm scripts; in the Docker image or
 * a global install it is `knowledge-mcp`; through npx it is the package name. A hint that does not run as typed
 * is worse than no hint.
 *
 *   started by an npm script of a project     npm run setup -- check     (the script must exist in that project)
 *   started through npx                       npx @chnxthr/knowledge-mcp setup check
 *   started by another npm script              npx knowledge-mcp setup check   (the binary in node_modules)
 *   anything else                             knowledge-mcp setup check
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';

const BINARY = 'knowledge-mcp';
const PACKAGE = '@chnxthr/knowledge-mcp';

let _scripts: Record<string, string> | null | undefined;

/** Scripts of the project whose `npm run …` started this process, or null when it was not started that way. */
function projectScripts(env: NodeJS.ProcessEnv): Record<string, string> | null {
  if (env !== process.env) return readScripts(env);
  if (_scripts === undefined) _scripts = readScripts(env);
  return _scripts;
}

function readScripts(env: NodeJS.ProcessEnv): Record<string, string> | null {
  if (env.npm_command !== 'run-script' || !env.npm_package_json) return null;
  try {
    const scripts: unknown = JSON.parse(readFileSync(env.npm_package_json, 'utf8')).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** Does this npm script start this program (the project's own server file or the binary)? */
const startsThis = (script: string | undefined): boolean => !!script && /(server\.(ts|js)|knowledge-mcp)\b/.test(script);

/**
 * The command line for `command` ("setup check", "doctor", "shop tables"), as it has to be typed here.
 * `env` is for tests.
 */
export function cli(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const scripts = projectScripts(env);
  if (scripts) {
    const [first, ...rest] = command.split(' ');
    // `npm run dev` is how a generated project serves.
    if (first === 'serve' && rest.length === 0 && startsThis(scripts.dev)) return 'npm run dev';
    // A script named after the command and ending in it: "setup": "tsx src/server.ts setup".
    if (startsThis(scripts[first]) && new RegExp(`\\s${first}$`).test(scripts[first].trim())) {
      return rest.length ? `npm run ${first} -- ${rest.join(' ')}` : `npm run ${first}`;
    }
    // A script that passes everything through: "mcp": "tsx src/server.ts".
    const passThrough = Object.entries(scripts).find(([, s]) => startsThis(s) && /server\.(ts|js)$/.test(s.trim()));
    if (passThrough) return `npm run ${passThrough[0]} -- ${command}`;
    // A project without such a script (made by an older generator): the binary in node_modules, through npx.
    return `npx ${BINARY} ${command}`;
  }
  if (env.npm_command === 'exec') return `npx ${PACKAGE} ${command}`;
  return `${BINARY} ${command}`;
}

/** One word of a command line for a POSIX shell, quoted when the shell would split or change it. */
export const shellQuote = (word: string): string => (/[^A-Za-z0-9_@%+=:,./-]/.test(word) ? `'${word.replace(/'/g, `'\\''`)}'` : word);

/**
 * The TypeScript config tsx is told to use for the project in `dir`: its own tsconfig.json, or none at all (the null
 * device) when it has none. Left to itself, tsx reads the tsconfig.json of the working directory, which is the project
 * the person has open in the client: its "paths" can map the import of this package to a file of that repository,
 * whose code then runs as the server.
 */
function tsconfigOf(dir: string, platform: NodeJS.Platform): string {
  const own = join(dir, 'tsconfig.json');
  return existsSync(own) ? own : platform === 'win32' ? '\\\\.\\nul' : '/dev/null';
}

/** The copy of this package an entry without a project runs: in node_modules of the settings folder, pinned. */
export interface PackageInstall {
  /** What npm installs: this package at this very version. */
  spec: string;
  /** The settings folder it goes into (npm's --prefix, and the folder npm runs in). */
  prefix: string;
}

/** How an AI client starts this server over stdio. */
export interface StdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Set when the copy the entry runs is not there yet: install it first (installPackage). */
  install?: PackageInstall;
}

/** This package's cli.js inside node_modules of the folder `dir`. */
const copyIn = (dir: string): string => join(dir, 'node_modules', ...PACKAGE.split('/'), 'dist', 'cli.js');

/** The version of the package whose cli.js this is, or null. */
function versionOf(cli: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * This running package's own cli.js, when an entry may point at it: a built copy that stays where it is (a global
 * install, a linked checkout, the Docker image). Null when it runs from source, and when it runs from a cache that
 * npx (or pnpm dlx, or bunx) fills. That folder is shared by every run of the package name, including runs that a
 * repository's .npmrc sent to another registry while entries still went through npx, and it may be emptied any time.
 */
export function ownCli(): string | null {
  if (!import.meta.url.endsWith('.js')) return null;
  try {
    const cli = realpathSync(fileURLToPath(new URL('../cli.js', import.meta.url)));
    const parts = cli.split(/[\\/]/);
    const cached = parts.some((p) => p === '_npx' || p === 'dlx' || p.startsWith('bunx-')) || cli.startsWith(realpathSync(tmpdir()) + sep);
    return cached ? null : cli;
  } catch {
    return null;
  }
}

/**
 * The entry an AI client is given to start this server over stdio from the folder `dir`.
 *
 * Every entry is Node itself, named by its full path, with the file it runs named by its full path: nothing is
 * looked up, and no shell is involved. A desktop app does not have the PATH of a terminal (started from the Dock it
 * finds no `node` that a version manager installed), and a client starts the server in the project the person has
 * open, which may be somebody else's repository:
 *
 *   a project with src/server.ts    <node> <dir>/node_modules/tsx/dist/cli.mjs --tsconfig <dir>/tsconfig.json
 *                                   <dir>/src/server.ts serve --stdio
 *   a built project                 <node> <dir>/dist/server.js serve --stdio
 *   no project                      <node> <cli.js of this package> serve --stdio: the copy in <dir>/node_modules
 *                                   when it is this version, else this running copy when it stays where it is
 *                                   (ownCli), else a copy of this version installed into <dir> first (`install`)
 *
 * Every entry sets MCP_HOME=<dir>: the settings of the folder the client starts in are never read (core/paths.ts).
 * tsx is given the project's tsconfig.json, since it would read the working directory's, whose "paths" can replace
 * the code that runs (tsconfigOf). No entry goes through npx: npm exec runs the package's bin in the working
 * directory, through a shell, with that folder's node_modules/.bin first on the PATH, so a repository's
 * node_modules/.bin/node, sh or knowledge-mcp ran in place of the real one. `own` is for tests.
 */
export function stdioEntry(dir: string, node: string = process.execPath, platform: NodeJS.Platform = process.platform, own: string | null = ownCli()): StdioEntry {
  const env = { MCP_HOME: dir };
  const project = join(dir, 'src', 'server.ts');
  const tsx = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(project) && existsSync(tsx)) return { command: node, args: [tsx, '--tsconfig', tsconfigOf(dir, platform), project, 'serve', '--stdio'], env };
  const built = join(dir, 'dist', 'server.js');
  if (existsSync(built)) return { command: node, args: [built, 'serve', '--stdio'], env };
  const copy = copyIn(dir);
  if (existsSync(copy) && versionOf(copy) === VERSION) return { command: node, args: [copy, 'serve', '--stdio'], env };
  if (own) return { command: node, args: [own, 'serve', '--stdio'], env };
  return { command: node, args: [copy, 'serve', '--stdio'], env, install: { spec: `${PACKAGE}@${VERSION}`, prefix: dir } };
}

/** Pinned in package.json, and no install scripts: no dependency of this package has one. */
const INSTALL_FLAGS = ['--save-exact', '--ignore-scripts', '--no-audit', '--no-fund'];

/** The npm install of `install` as a person types it (shown beside the entry, for adding it by hand). */
export const installCommandLine = (install: PackageInstall): string =>
  ['npm', 'install', '--prefix', install.prefix, ...INSTALL_FLAGS, install.spec].map(shellQuote).join(' ');

/** npm's own script beside this Node, run by this Node: neither `npm` nor `node` is looked up on a PATH. */
function npmCli(node: string): string | null {
  let bin = dirname(node);
  try {
    bin = dirname(realpathSync(node));
  } catch {
    /* keep the folder as given */
  }
  // Windows keeps npm in node_modules beside node.exe; everywhere else it is in lib/node_modules next to bin/.
  const found = [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => existsSync(p));
  return found ?? null;
}

/**
 * Install the copy an entry runs (StdioEntry.install) into the settings folder. npm runs in that folder with
 * --prefix, so its .npmrc and nothing of any other folder is read; and without the npm_* variables of whatever npm
 * started this program (npx sets them from the folder it ran in). `output`: npm's lines go to the terminal, or are
 * kept and returned (the console makes its error from them). Resolves with ok false, never throws.
 */
export function installPackage(
  install: PackageInstall,
  o: { node?: string; env?: NodeJS.ProcessEnv; output?: 'inherit' | 'keep'; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const node = o.node ?? process.execPath;
  const cli = npmCli(node);
  if (!cli) return Promise.resolve({ ok: false, output: `npm was not found beside ${node}. Install the package by hand: ${installCommandLine(install)}` });
  const env = Object.fromEntries(Object.entries(o.env ?? process.env).filter(([k]) => !/^npm_/i.test(k)));
  return new Promise((done) => {
    let output = '';
    const keep = (chunk: Buffer) => void (output = (output + chunk.toString('utf8')).slice(-16_000));
    const child = spawn(node, [cli, 'install', '--prefix', install.prefix, ...INSTALL_FLAGS, install.spec], {
      cwd: install.prefix,
      env,
      stdio: o.output === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const limit = setTimeout(() => {
      output += '\nThe install did not finish in ten minutes and was stopped.';
      child.kill();
    }, o.timeoutMs ?? 10 * 60_000);
    child.on('error', (e) => {
      clearTimeout(limit);
      done({ ok: false, output: `npm could not be started (${e.message}).` });
    });
    child.on('close', (code) => {
      clearTimeout(limit);
      const there = existsSync(copyIn(install.prefix));
      done({ ok: code === 0 && there, output: code === 0 && !there ? `${output}\n${install.spec} has no dist/cli.js.` : output });
    });
  });
}
