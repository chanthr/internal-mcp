/**
 * Read and update a .env file without disturbing what is already there.
 *
 * The setup wizard writes the values it collected here. Existing lines keep their place and their comments; a key
 * that is already present is replaced on its own line (also when it was commented out as `# KEY=`), new keys are
 * appended. The file is created owner-only (0600) because it holds tokens.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Quote a value when dotenv would otherwise misread it (spaces, `#`, quotes, line breaks). */
export function formatEnvValue(value: string): string {
  if (value === '' || /^[A-Za-z0-9_\-./:@+=,~%]+$/.test(value)) return value;
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * The values that are set (not commented out, not empty) in the file, as written by `formatEnvValue`: quotes
 * removed. A name set twice has its last value, as when the file is loaded.
 */
export function readEnvValues(path: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const raw = m?.[2].trim();
    if (!m || !raw) continue;
    const single = /^'(.*)'$/.exec(raw);
    const double = /^"(.*)"$/.exec(raw);
    values.set(m[1], single ? single[1] : double ? double[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)) : raw);
  }
  return values;
}

/** Keys that are set (not commented out, not empty) in the file. */
export function readEnvKeys(path: string): Set<string> {
  return new Set(readEnvValues(path).keys());
}

/**
 * Set or remove values. `undefined` removes the key (its line becomes a comment so the name stays discoverable).
 * Returns the names that were written.
 */
export function updateEnvFile(path: string, values: Record<string, string | undefined>): string[] {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const pending = new Map(Object.entries(values));
  const written: string[] = [];
  const out = lines.map((line) => {
    const m = line.match(/^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !pending.has(m[2])) return line;
    const key = m[2];
    const value = pending.get(key);
    if (value === undefined) {
      return m[1] ? line : `# ${key}=`; // an active line is turned off; a commented line is left as it is
    }
    pending.delete(key);
    written.push(key);
    return `${key}=${formatEnvValue(value)}`;
  });
  const fresh = [...pending].filter(([, v]) => v !== undefined) as Array<[string, string]>;
  if (fresh.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    if (out.length && out[out.length - 1] === '' && out.length > 1) out.pop();
    if (out.length) out.push('');
    out.push('# Added by `knowledge-mcp setup`');
    for (const [key, value] of fresh) {
      out.push(`${key}=${formatEnvValue(value)}`);
      written.push(key);
    }
  }
  const text = out.join('\n').replace(/\n*$/, '\n');
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync keeps the mode of an existing file
  return written;
}
