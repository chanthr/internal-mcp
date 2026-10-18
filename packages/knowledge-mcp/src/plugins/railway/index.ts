/**
 * Railway plugin — services, deployments and logs over Railway's GraphQL API (logs are masked).
 *
 *   RAILWAY_TOKEN                    team/account token for every project (a project token sees one project)
 *   RAILWAY_MCP_URL + RAILWAY_MCP_TOKEN  optional remote Railway MCP through the gateway (railway_<name>)
 * When a remote tool has the same name as a local one, the local tool wins.
 */
import { definePlugin } from '../../plugin/define.js';
import { railwayServicesTool, railwayDeploymentsTool, railwayLogsTool } from './tools.js';

const token = () => process.env.RAILWAY_TOKEN || process.env.RAILWAY_MCP_TOKEN;

export const railwayPlugin = definePlugin({
  id: 'railway',
  description: 'Railway services, deployments and logs',
  enabled: () => !!token()?.trim() || 'set RAILWAY_TOKEN',
  tools: [railwayServicesTool, railwayDeploymentsTool, railwayLogsTool],
  upstreams: () =>
    process.env.RAILWAY_MCP_URL && process.env.RAILWAY_MCP_TOKEN
      ? [{ name: 'railway', url: process.env.RAILWAY_MCP_URL, prefix: 'railway_', token: process.env.RAILWAY_MCP_TOKEN }]
      : [],
  instructions: 'Railway: railway_services → railway_deployments → railway_logs.',
});
