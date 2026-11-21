/**
 * Side effects that must run before any other module of the package is evaluated.
 * index.ts imports this first: ESM evaluates imports in order, and several modules read process.env
 * when they load, so .env has to be in place before them.
 *
 *   1. Check MCP_HOME: a relative one, or a folder that does not exist, stops the process.
 *   2. A stdio server that would read the settings of the working directory stops (core/paths.ts stdioProblem),
 *      before any file there is read.
 *   3. Load .env — MCP_ENV_FILE if set (a relative one is in the settings folder), else the .env of the settings
 *      folder (core/paths.ts: MCP_HOME, else the app root, else the working directory). Existing env vars win.
 *      A named file that does not exist stops the process: running on the wrong settings is worse.
 *      MCP_ENV_FILE=none loads no file at all.
 *   4. Say so when the working directory holds settings that are not read, because another folder's are.
 *   5. Mask secrets in every console.* line.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { expandHome, home, homeProblem, SETTINGS, settingsFile, settingsFolder, stdioProblem } from './core/paths.js';
import { installLogMasking } from './core/log_mask.js';

/**
 * The environment as the process received it, before any .env file was read. A restarted server must be started
 * with this one: values from .env do not replace what is already set, so a child that inherited the loaded values
 * would never see an edited .env.
 */
export const ORIGINAL_ENV: NodeJS.ProcessEnv = { ...process.env };

const stop = (message: string): never => {
  console.error(`[knowledge-mcp] ${message}`);
  process.exit(1);
};

/**
 * Is this process a stdio server? `serve --stdio`, `--stdio`, or `serve` (the default command) with MCP_TRANSPORT=stdio
 * in the environment it was given. run.ts checks again once .env is read, which may set MCP_TRANSPORT too.
 */
function startsStdio(argv: string[]): boolean {
  const [cmd = 'serve', ...rest] = argv;
  return cmd === '--stdio' || (cmd === 'serve' && (rest.includes('--stdio') || process.env.MCP_TRANSPORT?.trim().toLowerCase() === 'stdio'));
}
const stdio = startsStdio(process.argv.slice(2));

const wrongHome = homeProblem();
if (wrongHome) stop(wrongHome);
if (stdio) {
  const problem = stdioProblem();
  if (problem) stop(problem);
}

const explicit = process.env.MCP_ENV_FILE?.trim();
// A relative file is in the settings folder, as MCP_CONFIG_PATH and MCP_DATA_DIR are: the working directory may be a
// folder the person did not choose (core/paths.ts).
const named = explicit && explicit !== 'none' ? resolve(settingsFolder(), expandHome(explicit)) : undefined;
if (named && !existsSync(named)) stop(`MCP_ENV_FILE points to a file that does not exist: ${named}`);
const files = explicit === 'none' ? [] : named ? [named] : [settingsFile('.env')].filter((f) => existsSync(f));
for (const path of files) loadDotenv({ path, quiet: true });
// MCP_HOME is read from the environment the process was given, never from a .env: the folder of that file was chosen
// without it, and a relative value there would stop every later lookup.
if (ORIGINAL_ENV.MCP_HOME === undefined) delete process.env.MCP_HOME;

// Someone who runs the program inside their own folder of settings, while the program's folder (a checkout linked
// with npm link, say) has settings too, gets that folder's. Said once, on stderr: never by a stdio server, whose
// folder is the client's choice (and where MCP_HOME=<that folder> would be the wrong advice), and not again by a
// server the supervisor restarts.
if (!stdio && !home() && process.env.KMCP_SUPERVISED !== '1') {
  const folder = settingsFolder();
  const here = process.cwd();
  const chosen = (file: string) =>
    file === '.env' ? !!explicit : !!(process.env.MCP_CONFIG_JSON?.trim() || process.env.MCP_CONFIG_PATH?.trim());
  const unread = folder === here ? [] : SETTINGS.filter((file) => !chosen(file) && existsSync(join(here, file)));
  if (unread.length) {
    console.error(`[knowledge-mcp] Using the settings in ${folder}, not the ${unread.join(' and ')} in this folder. To use this folder, set MCP_HOME=${here}`);
  }
}

installLogMasking();
