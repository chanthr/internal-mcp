/**
 * Where the server looks for .env, mcp.config.json and its data directory.
 *
 * MCP clients often spawn stdio servers from a different working directory, so the current directory
 * alone is not enough. The "app root" is the nearest folder with a package.json above the entry script
 * (your project when you run `node dist/server.js`), unless that is inside node_modules (npx), in which
 * case the working directory is used.
 *
 * The settings folder is the one folder whose .env and mcp.config.json are read:
 *
 *   MCP_HOME is set                          that folder, and nothing else
 *   the app root has .env or mcp.config.json the app root
 *   neither                                  the working directory
 *
 * The working directory comes last because it is not always the person's choice. An AI client starts a stdio
 * server in the project the person has open, which may be somebody else's repository: a .env there (dotenv keeps
 * the first value it reads) used to send every document to an address of its choosing with the person's key, and
 * an mcp.config.json there replaced the whole config. It is still read when the app root holds no settings, so
 * that someone who runs the program inside their own folder of settings keeps working. Every entry the console and
 * the setup commands write names MCP_HOME, so a client never depends on that rule, and a stdio server that would
 * read the working directory refuses to start (stdioProblem).
 *
 * MCP_HOME is a full path; a leading ~ is the home directory. A shell does not expand ~ inside `-e MCP_HOME=~/x`
 * and a client's JSON config never does, so the variable often arrives as typed. A relative path is refused, never
 * read against the working directory: that would let the folder a client starts in choose the settings again.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** A path as a person types it: a leading ~ is their home directory. */
export const expandHome = (path: string): string => path.replace(/^~(?=$|[\\/])/, () => homedir());

/** What is wrong with MCP_HOME, in a sentence, or null when it is unset or names a folder that exists. */
export function homeProblem(): string | null {
  const value = process.env.MCP_HOME?.trim();
  if (!value) return null;
  const path = expandHome(value);
  if (!isAbsolute(path)) {
    return `MCP_HOME must be a full path, such as ${join(homedir(), 'my-mcp')}. "${value}" would be looked up in whichever folder the server is started in.`;
  }
  try {
    if (statSync(path).isDirectory()) return null;
  } catch {
    /* does not exist */
  }
  return `MCP_HOME points to a folder that does not exist: ${path}`;
}

/** The folder named by MCP_HOME, when it is set. A relative one throws (bootstrap.ts has stopped the process before). */
export function home(): string | null {
  const value = process.env.MCP_HOME?.trim();
  if (!value) return null;
  const path = expandHome(value);
  if (!isAbsolute(path)) throw new Error(homeProblem() ?? 'MCP_HOME must be a full path');
  return resolve(path);
}

let _project: { dir: string; found: boolean } | undefined;

/** The folder of the program's own package.json (see above), or the working directory when there is none. */
function project(): { dir: string; found: boolean } {
  if (_project) return _project;
  _project = { dir: process.cwd(), found: false };
  const entry = process.argv[1];
  if (entry) {
    try {
      let dir = dirname(realpathSync(entry));
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'package.json'))) {
          if (!dir.split(/[\\/]/).includes('node_modules')) _project = { dir, found: true };
          break;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    } catch {
      /* entry not on disk (REPL, eval) → working directory */
    }
  }
  return _project;
}

export function appRoot(): string {
  return home() ?? project().dir;
}

/** The two files a settings folder holds. */
export const SETTINGS = ['.env', 'mcp.config.json'];

/** The folder whose .env and mcp.config.json are read (see above). Decided on each call: the console may write the first file. */
export function settingsFolder(): string {
  const named = home();
  if (named) return named;
  const root = appRoot();
  return SETTINGS.some((file) => existsSync(join(root, file))) ? root : process.cwd();
}

/**
 * Who chose the settings folder: MCP_HOME, the program's own project folder, or nobody (the working directory, which
 * is the client's choice when a client starts the server). The working directory counts as the project when the
 * two are the same folder, as in the Docker image.
 */
export function settingsOrigin(): 'home' | 'project' | 'cwd' {
  if (home()) return 'home';
  const own = project();
  return own.found && settingsFolder() === own.dir ? 'project' : 'cwd';
}

/**
 * Why a stdio server may not start, or null. Without MCP_HOME a stdio server would read the settings of the working
 * directory whenever its own folder holds none: under npx always, since the program lives in npm's cache. The client
 * picks that folder, and an entry written by hand without MCP_HOME was the way a repository's .env got in.
 */
export function stdioProblem(): string | null {
  if (settingsOrigin() !== 'cwd') return null;
  return (
    'A server started over stdio needs MCP_HOME, the full path of the folder with your .env and mcp.config.json. ' +
    'An AI client starts the server in whatever folder you have open, and the settings found there may be somebody ' +
    'else\'s. Add it to the client\'s entry: claude mcp add <name> -e MCP_HOME=/full/path -- ..., or ' +
    '"env": { "MCP_HOME": "/full/path" } in a JSON config.'
  );
}

/** Where a settings file is read from: in the settings folder. */
export function settingsFile(file: string): string {
  return resolve(settingsFolder(), file);
}

/** Data directory (SQLite store, checkpoints). MCP_DATA_DIR (a relative one is in the settings folder), else <app root>/data. */
export function dataDir(): string {
  return process.env.MCP_DATA_DIR ? resolve(settingsFolder(), process.env.MCP_DATA_DIR) : join(appRoot(), 'data');
}
