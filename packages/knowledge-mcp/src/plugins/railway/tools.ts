/**
 * Our own Railway GraphQL tools: they call Railway's public GraphQL API directly.
 *
 * Why our own tools: the Railway remote MCP (mcp.railway.com) is OAuth-only (it rejects project tokens), so it
 * cannot be used on an unattended server. The public GraphQL API supports token auth, so it is called directly.
 *
 * What it calls with (login.ts): RAILWAY_TOKEN when set, else the sign-in made from the console.
 *   RAILWAY_TOKEN: listing every project needs a team/account token. A project token is blocked from
 *   me/projects, so it can only read one project (project(id)).
 *   A sign-in sees the workspaces the person picked on Railway's consent screen, as a viewer.
 *
 * 3 tools: railway_services (list) -> railway_deployments (deploy status) -> railway_logs (logs)
 */
import { z } from 'zod';
import { defineTool } from '../../plugin/define.js';
import { getAuth } from '../../core/context.js';
import { maskString } from '../../core/log_mask.js';
import { railwayAuth } from './login.js';

const RAILWAY_TIMEOUT_MS = 20_000;

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { token, api } = await railwayAuth();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(api, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`Railway GraphQL timeout ${RAILWAY_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const j = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new Error(`Railway GraphQL: ${j.errors.map((e) => e.message).join('; ')}`);
  return j.data as T;
}

function errOut(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `[error] ${msg}` }], isError: true };
}

// ── 1. railway_services: list of all projects, services and environments ──
export const railwayServicesTool = defineTool({
  name: 'railway_services',
  description:
    'Lists all Railway projects, services, and environments. Call this first, before checking deployment status or logs, ' +
    'to find projectId / serviceId / environmentId. (A team token returns everything; a project token returns one project)',
  annotations: { readOnlyHint: true },
  run: () => handleRailwayServices(),
});

export async function handleRailwayServices() {
  getAuth();
  try {
    const d = await gql(`{
      projects(first: 50) {
        edges { node {
          id name
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        } }
      }
    }`);
    const projects = (d.projects?.edges ?? []).map((e: any) => ({
      id: e.node.id,
      name: e.node.name,
      services: (e.node.services?.edges ?? []).map((s: any) => ({ id: s.node.id, name: s.node.name })),
      environments: (e.node.environments?.edges ?? []).map((v: any) => ({ id: v.node.id, name: v.node.name })),
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ count: projects.length, projects }, null, 2) }],
    };
  } catch (e) {
    return errOut(e);
  }
}

// ── 2. railway_deployments: recent deploy status of a service ──
const depSchema = z.object({
  projectId: z.string().min(1),
  serviceId: z.string().min(1),
  environmentId: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5).describe('Default 5 (1~20)'),
});

export const railwayDeploymentsTool = defineTool({
  name: 'railway_deployments',
  description:
    'Recent deployment status of one Railway service (SUCCESS/FAILED/BUILDING/CRASHED, etc.). ' +
    'Pass the projectId, serviceId, and environmentId returned by railway_services.',
  input: depSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleRailwayDeployments(args),
});

export async function handleRailwayDeployments(args: z.infer<typeof depSchema>) {
  getAuth();
  const { projectId, serviceId, environmentId, limit } = args;
  try {
    const d = await gql(
      `query($p:String!,$s:String!,$e:String!,$n:Int!){
        deployments(first:$n, input:{ projectId:$p, serviceId:$s, environmentId:$e }) {
          edges { node { id status createdAt staticUrl url } }
        }
      }`,
      { p: projectId, s: serviceId, e: environmentId, n: limit },
    );
    const deps = (d.deployments?.edges ?? []).map((e: any) => ({
      id: e.node.id,
      status: e.node.status,
      createdAt: e.node.createdAt,
      url: e.node.staticUrl || e.node.url || null,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ count: deps.length, deployments: deps }, null, 2) }],
    };
  } catch (e) {
    return errOut(e);
  }
}

// ── 3. railway_logs: deploy/build logs ──
const logSchema = z.object({
  deploymentId: z.string().min(1),
  type: z.enum(['deploy', 'build']).default('deploy').describe('Default deploy'),
  limit: z.number().int().min(1).max(500).default(100).describe('Default 100 (1~500)'),
  filter: z.string().optional().describe('Log filter string (optional)'),
});

export const railwayLogsTool = defineTool({
  name: 'railway_logs',
  description:
    'Logs of a Railway deployment (type="deploy" runtime logs / "build" build logs). ' +
    'Pass the deploymentId returned by railway_deployments.',
  input: logSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleRailwayLogs(args),
});

export async function handleRailwayLogs(args: z.infer<typeof logSchema>) {
  getAuth();
  const { deploymentId, type, limit, filter } = args;
  try {
    const field = type === 'build' ? 'buildLogs' : 'deploymentLogs';
    const d = await gql(
      `query($d:String!,$n:Int!,$f:String){
        ${field}(deploymentId:$d, limit:$n, filter:$f) { message timestamp severity }
      }`,
      { d: deploymentId, n: limit, f: filter },
    );
    const logs = (d[field] ?? []) as Array<{ message: string; timestamp: string; severity?: string }>;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // Tokens and keys in the log body are masked before responding, so a person reading the logs does not
            // also see that service's secrets.
            { type, count: logs.length, logs: logs.map((l) => ({ ts: l.timestamp, sev: l.severity, msg: maskString(l.message ?? '') })) },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e) {
    return errOut(e);
  }
}
