/**
 * Where the server looks for .env, mcp.config.json and its data directory.
 *
 * MCP clients often spawn stdio servers from a different working directory, so the current directory
 * alone is not enough. The "app root" is the nearest folder with a package.json above the entry script
 * (your project when you run `node dist/server.js`), unless that is inside node_modules (npx), in which
 * case the working directory is used.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let _appRoot: string | undefined;

export function appRoot(): string {
  if (_appRoot) return _appRoot;
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

/** Candidate paths for a file: working directory first, then the app root. Duplicates removed. */
export function candidates(file: string): string[] {
  const list = [resolve(process.cwd(), file), resolve(appRoot(), file)];
  return [...new Set(list)];
}

/** Data directory (SQLite store, checkpoints). MCP_DATA_DIR, else <app root>/data. */
export function dataDir(): string {
  return process.env.MCP_DATA_DIR ? resolve(process.env.MCP_DATA_DIR) : join(appRoot(), 'data');
}
