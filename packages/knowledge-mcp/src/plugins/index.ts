/**
 * Built-in plugins. Each one turns itself on when its credentials are in env, so listing all of them
 * costs nothing: `knowledge-mcp doctor` shows which are on and what each one is missing.
 */
import type { Plugin } from '../plugin/define.js';
import { drivePlugin } from './drive/index.js';
import { slackPlugin } from './slack/index.js';
import { githubPlugin } from './github/index.js';
import { railwayPlugin } from './railway/index.js';

export { drivePlugin, slackPlugin, githubPlugin, railwayPlugin };

export const builtinPlugins: Plugin[] = [drivePlugin, slackPlugin, githubPlugin, railwayPlugin];
