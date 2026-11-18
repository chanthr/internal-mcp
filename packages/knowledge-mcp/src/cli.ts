#!/usr/bin/env node
/** `knowledge-mcp` binary — the server with the built-in plugins (Drive, Slack, GitHub, Railway). */
import { superviseIfServing } from './admin/launch.js';

// A server started by a person in a terminal runs as the child of this process. Decided before the server is
// loaded: the supervisor then stays small (it never returns from here).
await superviseIfServing(process.argv.slice(2));

const { run } = await import('./index.js');
await run();
