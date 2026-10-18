/**
 * GitHub plugin — repo_tree (local) plus GitHub's remote MCP server through the gateway, read-only.
 *
 *   GITHUB_TOKEN (or GITHUB_PAT)    fine-grained token with Contents: read (Metadata: read)
 *   GITHUB_MCP_INSIDERS=true        optional, opts into GitHub MCP insiders tools
 * Remote tools appear as github_<name>; only read verbs (get_, list_, search_ ...) are exposed.
 */
import { definePlugin } from '../../plugin/define.js';
import { repoTreeTool } from './repo_tree.js';

const token = () => process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;

export const githubPlugin = definePlugin({
  id: 'github',
  description: 'GitHub repo tree + remote GitHub MCP (read-only)',
  enabled: () => !!token()?.trim() || 'set GITHUB_TOKEN (or GITHUB_PAT)',
  tools: [repoTreeTool],
  upstreams: () => [
    {
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      prefix: 'github_',
      token,
      headers: process.env.GITHUB_MCP_INSIDERS === 'true' ? { 'X-MCP-Insiders': 'true' } : undefined,
    },
  ],
  instructions: 'GitHub: code structure → repo_tree first, then github_get_file_contents for the files you need.',
});
