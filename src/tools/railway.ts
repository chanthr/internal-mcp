/**
 * Railway 자체 GraphQL 툴 — backboard.railway.app/graphql/v2 직접 호출.
 *
 * 왜 자체 툴: Railway remote MCP(mcp.railway.com)는 OAuth 전용(Project token 거부)이라
 * 무인 서버(중앙 MCP)에서 못 씀. Public GraphQL API 는 token 인증을 지원하므로 이걸 직접 호출.
 *
 * RAILWAY_TOKEN: 전체 프로젝트 조회는 team/account token 필요.
 *   project token 은 me/projects 가 막혀 한 프로젝트(project(id))만 가능.
 *
 * 3 툴: railway_services(목록) → railway_deployments(배포상태) → railway_logs(로그)
 */
import { z } from 'zod';
import { getAuth } from '../lib/context.js';
import { maskString } from '../lib/log_mask.js';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

function railwayHeaders(): Record<string, string> {
  const token = process.env.RAILWAY_TOKEN || process.env.RAILWAY_MCP_TOKEN;
  if (!token) throw new Error('[railway] RAILWAY_TOKEN (또는 RAILWAY_MCP_TOKEN) 미설정');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const RAILWAY_TIMEOUT_MS = 20_000;

async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: railwayHeaders(),
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

// ── 1. railway_services — 전체 프로젝트·서비스·환경 목록 ──
export const railwayServicesTool = {
  name: 'railway_services',
  description:
    'Railway 전체 프로젝트·서비스·환경 목록. 배포 상태/로그 조회 전 먼저 호출해 ' +
    'projectId / serviceId / environmentId 를 파악하라. (team token 이면 전체, project token 이면 한 프로젝트)',
  inputSchema: { type: 'object' as const, properties: {} },
};

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

// ── 2. railway_deployments — 서비스 최근 배포 상태 ──
export const railwayDeploymentsTool = {
  name: 'railway_deployments',
  description:
    'Railway 특정 서비스의 최근 배포 상태(SUCCESS/FAILED/BUILDING/CRASHED 등). ' +
    'railway_services 로 얻은 projectId·serviceId·environmentId 를 넣는다.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      projectId: { type: 'string' },
      serviceId: { type: 'string' },
      environmentId: { type: 'string' },
      limit: { type: 'number', description: '기본 5 (1~20)' },
    },
    required: ['projectId', 'serviceId', 'environmentId'],
  },
};

const depSchema = z.object({
  projectId: z.string().min(1),
  serviceId: z.string().min(1),
  environmentId: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});

export async function handleRailwayDeployments(args: unknown) {
  getAuth();
  const { projectId, serviceId, environmentId, limit } = depSchema.parse(args);
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

// ── 3. railway_logs — 배포/빌드 로그 ──
export const railwayLogsTool = {
  name: 'railway_logs',
  description:
    'Railway 배포의 로그 (type="deploy" 런타임 로그 / "build" 빌드 로그). ' +
    'railway_deployments 로 얻은 deploymentId 를 넣는다.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      deploymentId: { type: 'string' },
      type: { type: 'string', enum: ['deploy', 'build'], description: '기본 deploy' },
      limit: { type: 'number', description: '기본 100 (1~500)' },
      filter: { type: 'string', description: '로그 필터 문자열 (선택)' },
    },
    required: ['deploymentId'],
  },
};

const logSchema = z.object({
  deploymentId: z.string().min(1),
  type: z.enum(['deploy', 'build']).default('deploy'),
  limit: z.number().int().min(1).max(500).default(100),
  filter: z.string().optional(),
});

export async function handleRailwayLogs(args: unknown) {
  getAuth();
  const { deploymentId, type, limit, filter } = logSchema.parse(args);
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
            // 로그 본문의 토큰·키는 응답 전에 가린다 — 로그를 읽는 사람이 그 서비스의 비밀값까지 보지 않게.
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
