/**
 * Our own Railway GraphQL tools: they call Railway's public GraphQL API directly.
 *
 * Why our own tools: the Railway remote MCP (mcp.railway.com) is OAuth-only (it rejects project tokens), so it
 * cannot be used on an unattended server. The public GraphQL API supports token auth, so it is called directly.
 *
 * What it calls with (login.ts): RAILWAY_TOKEN when set, else the sign-in made from the console.
 *   RAILWAY_TOKEN: listing every project needs a team/account token. A project token is blocked from
 *   me/projects, so it can only read one project (project(id)).
 *   A sign-in sees the workspaces the person picked on Railway's consent screen, as a viewer. It is not allowed
 *   to ask for "all projects": it asks for its workspaces, and the projects in each.
 *
 * 3 tools: railway_services (list) -> railway_deployments (deploy status) -> railway_logs (logs)
 */
import { z } from 'zod';
import { defineTool } from '../../plugin/define.js';
import { getAuth } from '../../core/context.js';
import { maskString } from '../../core/log_mask.js';
import { railwayAuth, type RailwayAuth } from './login.js';

const RAILWAY_TIMEOUT_MS = 20_000;

async function gql<T = any>(query: string, variables?: Record<string, unknown>, auth?: RailwayAuth): Promise<T> {
  const { token, api } = auth ?? (await railwayAuth());
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

export interface RailwayProject {
  id: string;
  name: string;
  /** The workspace it was found in (a sign-in). */
  workspace?: string;
  services: Array<{ id: string; name: string }>;
  environments: Array<{ id: string; name: string }>;
}

const PROJECTS = `edges { node {
          id name
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        } }`;
const asProject = (node: any, workspace?: string): RailwayProject => ({
  id: node.id,
  name: node.name,
  ...(workspace ? { workspace } : {}),
  services: (node.services?.edges ?? []).map((s: any) => ({ id: s.node.id, name: s.node.name })),
  environments: (node.environments?.edges ?? []).map((v: any) => ({ id: v.node.id, name: v.node.name })),
});

/** What to do when a sign-in is good and still sees nothing. `where` is who reads it: the console page, or a tool's answer. */
const pickAgain = (where: 'page' | 'tool') => (where === 'page' ? "Sign in again and pick a workspace on Railway's screen." : "Open the console (Apps → Railway), sign in again and pick a workspace on Railway's screen.");

/**
 * Every project the token can see, and for a sign-in the workspaces they are in.
 * `auth` is given for a token that is not saved yet (the console, straight after a sign-in).
 */
export async function railwayProjects(auth?: RailwayAuth, where: 'page' | 'tool' = 'tool'): Promise<{ projects: RailwayProject[]; workspaces: string[] | null }> {
  const a = auth ?? (await railwayAuth());
  if (a.via === 'token') {
    const d = await gql(`{ projects(first: 50) { ${PROJECTS} } }`, undefined, a);
    return { projects: (d.projects?.edges ?? []).map((e: any) => asProject(e.node)), workspaces: null };
  }
  let found: any[];
  try {
    found = (await gql(`{ me { workspaces { id name projects(first: 50) { ${PROJECTS} } } } }`, undefined, a)).me?.workspaces ?? [];
  } catch (e) {
    const said = e instanceof Error ? e.message.replace(/^Railway GraphQL: /, '') : String(e);
    if (!/not authori[sz]ed/i.test(said)) throw e;
    throw new Error(`Railway: the sign-in does not let this server see a workspace (Railway said: ${said.slice(0, 80)}). ${pickAgain(where)}`);
  }
  if (found.length === 0) throw new Error(`Railway: the sign-in shares no workspace with this server. ${pickAgain(where)}`);
  return {
    projects: found.flatMap((w) => (w.projects?.edges ?? []).map((e: any) => asProject(e.node, w.name))),
    workspaces: found.map((w) => String(w.name)),
  };
}

export async function handleRailwayServices() {
  getAuth();
  try {
    const { projects, workspaces } = await railwayProjects();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ count: projects.length, ...(workspaces ? { workspaces } : {}), projects }, null, 2) }],
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
  let auth: RailwayAuth | undefined;
  try {
    auth = await railwayAuth();
    const field = type === 'build' ? 'buildLogs' : 'deploymentLogs';
    const d = await gql(
      `query($d:String!,$n:Int!,$f:String){
        ${field}(deploymentId:$d, limit:$n, filter:$f) { message timestamp severity }
      }`,
      { d: deploymentId, n: limit, f: filter },
      auth,
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
    // Seen with a real sign-in: projects and deployments are listed, logs are refused. Railway shows logs to the
    // members of a workspace, and the sign-in asks for viewer access so that it cannot change anything.
    if (auth?.via === 'login' && e instanceof Error && /not authori[sz]ed/i.test(e.message)) {
      return errOut(new Error('Railway: this sign-in lists projects and deployments, but Railway does not show it the logs. The sign-in asks for viewer access, and logs are for members of the workspace. To read logs, paste a Railway token in the console (Apps → Railway) or set RAILWAY_TOKEN.'));
    }
    return errOut(e);
  }
}
