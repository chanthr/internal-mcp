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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

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

/** How an AI client starts this server over stdio from the folder `dir`: the project's own server when there is one. */
export function stdioCommand(dir: string): string[] {
  const tsx = join(dir, 'node_modules', '.bin', 'tsx');
  const own = join(dir, 'src', 'server.ts');
  if (existsSync(own) && existsSync(tsx)) return [tsx, own, 'serve', '--stdio'];
  const built = join(dir, 'dist', 'server.js');
  if (existsSync(built)) return ['node', built, 'serve', '--stdio'];
  return ['npx', '-y', '@chnxthr/knowledge-mcp', 'serve', '--stdio'];
}

/**
 * The entry an AI client is given to start this server over stdio from the folder `dir`.
 *
 * A desktop app does not have the PATH of a terminal: started from the Dock it finds no `node` and no `npx` that
 * a version manager installed, and the server never starts ("spawn npx ENOENT"). So the entry names this very
 * Node by its full path, and nothing is looked up:
 *
 *   a project with src/server.ts    <node> <dir>/node_modules/tsx/dist/cli.mjs <dir>/src/server.ts serve --stdio
 *   a built project                 <node> <dir>/dist/server.js serve --stdio
 *   no project (started by npx)     <node's folder>/npx -y @chnxthr/knowledge-mcp serve --stdio
 *                                   with MCP_HOME=<dir>, and a PATH that holds node (npx is a script that asks for it)
 */
export function stdioEntry(dir: string, node: string = process.execPath, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; env?: Record<string, string> } {
  const own = join(dir, 'src', 'server.ts');
  const tsx = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(own) && existsSync(tsx)) return { command: node, args: [tsx, own, 'serve', '--stdio'] };
  const built = join(dir, 'dist', 'server.js');
  if (existsSync(built)) return { command: node, args: [built, 'serve', '--stdio'] };
  const args = ['-y', PACKAGE, 'serve', '--stdio'];
  // Windows starts npx through a .cmd file, and its apps do get the PATH: the plain name is right there.
  if (platform === 'win32') return { command: 'npx', args, env: { MCP_HOME: dir } };
  let bin = dirname(node);
  try {
    bin = dirname(realpathSync(node));
  } catch {
    /* keep the folder as given */
  }
  const npx = join(bin, 'npx');
  return {
    command: existsSync(npx) ? npx : 'npx',
    args,
    env: { MCP_HOME: dir, PATH: [bin, '/usr/local/bin', '/usr/bin', '/bin'].filter((d, i, all) => all.indexOf(d) === i).join(delimiter) },
  };
}
