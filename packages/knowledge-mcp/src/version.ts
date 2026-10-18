/** Package version, read from package.json (one directory above both src/ and dist/). */
import { readFileSync } from 'node:fs';

export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
