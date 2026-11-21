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
 * the setup commands write names MCP_HOME, so a client never depends on that rule.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let _appRoot: string | undefined;

/** The folder named by MCP_HOME, when it is set. */
export function home(): string | null {
  const value = process.env.MCP_HOME?.trim();
  return value ? resolve(value) : null;
}

export function appRoot(): string {
  if (_appRoot) return _appRoot;
  const named = home();
  if (named) return (_appRoot = named);
  _appRoot = process.cwd();
  const entry = process.argv[1];
  if (entry) {
    try {
      let dir = dirname(realpathSync(entry));
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'package.json'))) {
          if (!dir.split(/[\\/]/).includes('node_modules')) _appRoot = dir;
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
  return _appRoot;
}

/** The two files a settings folder holds. */
const SETTINGS = ['.env', 'mcp.config.json'];

/** The folder whose .env and mcp.config.json are read (see above). Decided on each call: the console may write the first file. */
export function settingsFolder(): string {
  const named = home();
  if (named) return named;
  const root = appRoot();
  return SETTINGS.some((file) => existsSync(join(root, file))) ? root : process.cwd();
}

/** Where a settings file is read from: in the settings folder. */
export function settingsFile(file: string): string {
  return resolve(settingsFolder(), file);
}

/** Data directory (SQLite store, checkpoints). MCP_DATA_DIR (a relative one is in the settings folder), else <app root>/data. */
export function dataDir(): string {
  return process.env.MCP_DATA_DIR ? resolve(settingsFolder(), process.env.MCP_DATA_DIR) : join(appRoot(), 'data');
}
