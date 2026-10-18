/**
 * GitHub plugin — repo_tree (local) plus GitHub's remote MCP server through the gateway, read-only.
 *
 *   GITHUB_PAT (or GITHUB_TOKEN)    fine-grained token with Contents: read (Metadata: read)
 *   GITHUB_MCP_INSIDERS=true        optional, opts into GitHub MCP insiders tools
 * Remote tools appear as github_<name>; only read verbs (get_, list_, search_ ...) are exposed.
 */
import { definePlugin } from '../../plugin/define.js';
import { repoTreeTool } from './repo_tree.js';
import { githubToken } from './token.js';

export const githubPlugin = definePlugin({
  id: 'github',
  description: 'GitHub repo tree + remote GitHub MCP (read-only)',
  enabled: () => !!githubToken()?.trim() || 'set GITHUB_PAT (or GITHUB_TOKEN)',
  tools: [repoTreeTool],
  upstreams: () => [
    {
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      prefix: 'github_',
      token: githubToken,
      headers: process.env.GITHUB_MCP_INSIDERS === 'true' ? { 'X-MCP-Insiders': 'true' } : undefined,
    },
  ],
  instructions: 'GitHub: code structure → repo_tree first, then github_get_file_contents for the files you need.',
});
