#!/usr/bin/env node
/** `knowledge-mcp` binary — the server with the built-in plugins (Drive, Slack, GitHub, Railway). */
import { run } from './index.js';

await run();
