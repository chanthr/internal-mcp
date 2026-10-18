/**
 * loadPlugins(dir) — imports every plugin file in a folder, so adding a tool is adding a file.
 *
 *   await run({ plugins: [...builtinPlugins, ...(await loadPlugins(new URL('./plugins/', import.meta.url)))] });
 *
 * Loads *.ts / *.js / *.mts / *.mjs in name order. Skips *.d.ts, *.test.*, *.spec.* and names starting
 * with "_" or ".". Each file's default export must be a plugin made with definePlugin.
 * Works under tsx (src/*.ts) and after tsc (dist/*.js) with the same import.meta.url-relative path.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPlugin, type Plugin } from './define.js';

const PLUGIN_FILE = /\.(m?[jt]s)$/;
const SKIP = /(\.d\.[mc]?ts$)|(\.(test|spec)\.[mc]?[jt]s$)|(\.map$)/;

export async function loadPlugins(dir: string | URL): Promise<Plugin[]> {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir;
  if (!existsSync(path)) return [];
  const files = readdirSync(path)
    .filter((f) => PLUGIN_FILE.test(f) && !SKIP.test(f) && !f.startsWith('_') && !f.startsWith('.'))
    .filter((f) => statSync(join(path, f)).isFile())
    .sort();
  const out: Plugin[] = [];
  for (const f of files) {
    const full = join(path, f);
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(full).href)) as { default?: unknown };
    } catch (e) {
      throw new Error(`[plugin] failed to load ${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isPlugin(mod.default)) {
      throw new Error(`[plugin] ${full}: the default export must be definePlugin({...})`);
    }
    out.push(mod.default);
  }
  return out;
}
