/**
 * Railway plugin — services, deployments and logs over Railway's GraphQL API (logs are masked).
 *
 *   RAILWAY_TOKEN                    team/account token for every project (a project token sees one project)
 *   or a sign-in from the console    no token to copy: viewer access to the workspaces picked on Railway's screen
 *   RAILWAY_MCP_URL + RAILWAY_MCP_TOKEN  optional remote Railway MCP through the gateway (railway_<name>)
 * When a remote tool has the same name as a local one, the local tool wins.
 */
import { definePlugin } from '../../plugin/define.js';
import { railwayServicesTool, railwayDeploymentsTool, railwayLogsTool } from './tools.js';
import { railwayConfigured } from './login.js';

export const railwayPlugin = definePlugin({
  id: 'railway',
  description: 'Railway services, deployments and logs',
  enabled: () => railwayConfigured() || 'set RAILWAY_TOKEN, or sign in from the console (Apps)',
  tools: [railwayServicesTool, railwayDeploymentsTool, railwayLogsTool],
  upstreams: () =>
    process.env.RAILWAY_MCP_URL && process.env.RAILWAY_MCP_TOKEN
      ? [{ name: 'railway', url: process.env.RAILWAY_MCP_URL, prefix: 'railway_', token: process.env.RAILWAY_MCP_TOKEN }]
      : [],
  instructions: 'Railway: railway_services → railway_deployments → railway_logs.',
});
