/** Test server: built-in plugins plus test/fixtures/plugins, same shape as the generated server.ts. */
import { run, builtinPlugins, loadPlugins } from '../../src/index.js';

const mine = await loadPlugins(new URL('./plugins/', import.meta.url));
await run({ plugins: [...builtinPlugins, ...mine] });
