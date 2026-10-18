/**
 * @chanthr/knowledge-mcp — build your own MCP server from plugins.
 *
 *   import { run, builtinPlugins, loadPlugins } from '@chanthr/knowledge-mcp';
 *   await run({ plugins: [...builtinPlugins, ...(await loadPlugins(new URL('./plugins/', import.meta.url)))] });
 *
 * Importing this module loads .env and installs log masking first (bootstrap.ts), so import it before
 * anything that reads process.env.
 */
import './bootstrap.js';

export { definePlugin, defineTool, ToolError, isPlugin } from './plugin/define.js';
export type {
  Plugin, PluginSpec, PluginCommand, PluginState, Tool, ToolSpec, ToolContext, ToolResult, ToolReturn, UpstreamSpec,
} from './plugin/define.js';
export { loadPlugins } from './plugin/load.js';
export { Registry } from './plugin/registry.js';
export { run, type RunOptions } from './run.js';
export { builtinPlugins, drivePlugin, slackPlugin, githubPlugin, railwayPlugin } from './plugins/index.js';
export { getAuth, getAuthMaybe } from './core/context.js';
export { getConfig } from './core/config.js';
export { getStore } from './store/index.js';
export type { Store } from './store/types.js';
export type { AuthContext, Role, ResourceScopes } from './core/auth.js';
export { VERSION } from './version.js';
export { z } from 'zod';
