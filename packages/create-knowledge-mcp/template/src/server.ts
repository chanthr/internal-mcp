/**
 * Your MCP server. Every file in ./plugins is loaded as a plugin; the built-in Drive, Slack, GitHub and
 * Railway plugins turn on when their env vars are set (.env). `npm run doctor` shows what is on.
 *
 * The same file is the command line: serve, serve --stdio, keys, users, doctor, <plugin> <command>.
 */
import { run, builtinPlugins, loadPlugins } from '@chanthr/knowledge-mcp';

const mine = await loadPlugins(new URL('./plugins/', import.meta.url));

await run({ plugins: [...builtinPlugins, ...mine] });
