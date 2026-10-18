/**
 * MCP Aggregator — upstream MCP server (GitHub remote 등) 를 client 로 연결해
 * tool 들을 prefix 붙여 re-expose. knowledge-mcp 가 단일 gateway 가 되는 핵심.
 *
 * 디자인:
 *   - graceful (fail-open): upstream connect 실패해도 server 는 자체 tool 로 작동.
 *     upstream tool 만 목록에서 빠짐.
 *   - startup best-effort connect + tools/list 캐시. createServer (per-request) 는 캐시 참조.
 *   - tool name namespace: `{prefix}{원래이름}` (예: github_search_code). 충돌·라우팅 명확.
 *   - shared org token (env) for server-side auth -> clients present a single Bearer.
 *
 * 인증 패턴 (GitHub remote MCP 기준):
 *   - endpoint: https://api.githubcopilot.com/mcp/
 *   - header: Authorization: Bearer <회사 PAT>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface UpstreamConfig {
  /** 식별자 (로그용). 예: 'github' */
  name: string;
  /** tool 이름 prefix. 예: 'github_' → github_search_code */
  prefix: string;
  /** upstream MCP endpoint URL */
  url: string;
  /** 회사 공용 Bearer token (없으면 인증 헤더 생략) */
  authToken?: string;
  /** 추가 헤더 (예: X-MCP-Insiders) */
  extraHeaders?: Record<string, string>;
}

interface PrefixedTool extends Tool {
  name: string;
}

class UpstreamMcp {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private prefixedTools: PrefixedTool[] = [];
  private connected = false;
  private lastError: string | null = null;
  private connecting: Promise<void> | null = null; // single-flight — 동시 재연결 합치기(race·중복 소켓 방지)

  constructor(public readonly config: UpstreamConfig) {}

  /**
   * best-effort connect + tools/list 캐시. 실패해도 throw 안 함 (graceful).
   * single-flight: 여러 요청이 동시에 끊긴 upstream 을 만나도 한 번만 재연결하고 그 결과를 공유.
   */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting; // 진행 중인 연결에 합류
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    // 이전 transport 정리 — 덮어쓰기 전 close 로 소켓/SSE 누수 방지 (B-5).
    const prevTransport = this.transport;
    this.client = null;
    this.transport = null;
    this.connected = false;
    if (prevTransport) {
      try {
        await prevTransport.close();
      } catch {
        /* 이미 죽은 소켓 — 무시 */
      }
    }

    try {
      const headers: Record<string, string> = { ...(this.config.extraHeaders ?? {}) };
      if (this.config.authToken) {
        headers.Authorization = `Bearer ${this.config.authToken}`;
      }

      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers },
      });
      const client = new Client(
        { name: 'knowledge-mcp-gateway', version: '0.3.0' },
        { capabilities: {} },
      );

      await client.connect(transport);
      const res = await client.listTools();

      this.prefixedTools = res.tools.map((t) => ({
        ...t,
        name: `${this.config.prefix}${t.name}`,
        description: `[${this.config.name}] ${t.description ?? ''}`,
      }));
      // 성공 후에만 멤버 확정 (실패 시 이전 prefixedTools 유지 — 부분 상태 노출 방지)
      this.transport = transport;
      this.client = client;
      this.connected = true;
      this.lastError = null;
      console.error(
        `[upstream:${this.config.name}] connected · ${this.prefixedTools.length} tools (prefix ${this.config.prefix})`,
      );
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.connected = false;
      console.error(`[upstream:${this.config.name}] connect 실패 (graceful skip): ${this.lastError}`);
    }
  }

  getTools(): PrefixedTool[] {
    return this.connected ? this.prefixedTools : [];
  }

  /** 이 upstream 의 tool 인지 (prefix 매칭) */
  owns(toolName: string): boolean {
    return toolName.startsWith(this.config.prefix);
  }

  /** prefix 떼고 upstream 으로 forward. 끊겼으면 1회 lazy 재연결 후 재시도. */
  async callTool(toolName: string, args: Record<string, unknown>) {
    const realName = toolName.slice(this.config.prefix.length);

    // 끊긴 상태면 먼저 재연결 시도 (startup connect 후 idle/네트워크로 끊긴 경우 영구실패 방지)
    if (!this.client || !this.connected) {
      await this.connect();
      if (!this.client || !this.connected) {
        throw new Error(
          `[upstream:${this.config.name}] not connected${this.lastError ? ` (${this.lastError})` : ''}`,
        );
      }
    }

    try {
      return await this.client.callTool({ name: realName, arguments: args });
    } catch (e) {
      // 호출 중 연결이 죽었을 수 있음 — 1회 재연결 후 재시도
      this.connected = false;
      await this.connect();
      if (!this.client || !this.connected) throw e;
      return await this.client.callTool({ name: realName, arguments: args });
    }
  }

  status() {
    return {
      name: this.config.name,
      connected: this.connected,
      toolCount: this.prefixedTools.length,
      error: this.lastError,
    };
  }
}

/**
 * upstream(github_/railway_) 도구를 read-only 로 게이팅 — **허용리스트(default-deny)**.
 * 내부 프록시·act-as 직원 권한으로도 코드 수정·PR머지·삭제·파일생성이 자율 실행되지 않도록,
 * JSON-RPC 레벨에서 write 도구를 tools/list 에서 빼고 호출도 거부한다.
 * 자체 도구(index.ts switch 라우팅: railway_services 등)엔 적용되지 않음 — upstream 에만.
 *
 * 왜 허용리스트: 예전 블록리스트(write 동사 목록)는 목록 밖 이름(set_/enable_/dispatch_/assign_/
 * submit_/request_review 등)의 변경성 도구를 read-only 로 오판해 통과시키는 구멍이 있었다.
 * upstream 이 새 write 도구를 추가하면 자동으로 새는 구조 → prefix 뒤 첫 동사가 read 화이트리스트에
 * 있을 때만 통과하고, 모르는 동사는 전부 차단(fail-closed). read 도구가 누락 동사로 막히면 기능
 * 손실이지만 안전 쪽이고, 아래 로그로 발견해 동사를 추가하면 된다.
 */
const UPSTREAM_READ_VERBS = new Set<string>([
  'get', 'list', 'search', 'read', 'fetch', 'find', 'show', 'describe', 'view',
  // 'resolve' 는 넣지 않는다 — 리뷰 스레드 해결처럼 상태를 바꾸는 도구 이름에 쓰인다.
  'query', 'count', 'check', 'status', 'ping', 'download', 'export',
  'lookup', 'diff', 'blame', 'compare', 'log', 'history', 'scan', 'inspect',
]);
function isUpstreamReadOnly(toolName: string): boolean {
  // toolName = `{prefix}{원래이름}` (예: github_get_file_contents). prefix(github_/railway_) 뒤
  // 첫 토큰을 동사로 보고 화이트리스트 매칭. 매칭 안 되면 차단. (로그는 route()의 실제 차단 시에만 —
  // tools/list 필터에서 매번 찍으면 노이즈.)
  const m = toolName.match(/^[a-z]+_([a-z0-9]+)/i);
  return UPSTREAM_READ_VERBS.has((m?.[1] ?? '').toLowerCase());
}

/**
 * 모든 upstream 관리. startup 에서 connectAll, createServer 에서 tool aggregate.
 */
class UpstreamManager {
  private upstreams: UpstreamMcp[] = [];
  private initialized = false;

  /** env 에서 upstream config 빌드. token 있는 것만 등록. */
  build(): void {
    this.upstreams = [];

    // GitHub remote MCP — 회사 PAT 있을 때만
    const githubPat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
    if (githubPat) {
      const insiders = process.env.GITHUB_MCP_INSIDERS === 'true';
      this.upstreams.push(
        new UpstreamMcp({
          name: 'github',
          prefix: 'github_',
          url: 'https://api.githubcopilot.com/mcp/',
          authToken: githubPat,
          extraHeaders: insiders ? { 'X-MCP-Insiders': 'true' } : undefined,
        }),
      );
    }

    // Railway remote MCP — OAuth 기반이라 token 헤더 호환 확인 후 활성화 (env 토글)
    const railwayToken = process.env.RAILWAY_MCP_TOKEN;
    const railwayUrl = process.env.RAILWAY_MCP_URL; // 기본 mcp.railway.com 확인 후 설정
    if (railwayToken && railwayUrl) {
      this.upstreams.push(
        new UpstreamMcp({
          name: 'railway',
          prefix: 'railway_',
          url: railwayUrl,
          authToken: railwayToken,
        }),
      );
    }
  }

  /** startup — 모든 upstream best-effort connect (병렬). */
  async connectAll(): Promise<void> {
    if (this.upstreams.length === 0) this.build();
    await Promise.all(this.upstreams.map((u) => u.connect()));
    this.initialized = true;
  }

  /** 모든 upstream 의 prefixed tools (connected 만 · write 도구는 제외) */
  getAllTools(): PrefixedTool[] {
    return this.upstreams.flatMap((u) => u.getTools()).filter((t) => isUpstreamReadOnly(t.name));
  }

  /** toolName 을 소유한 upstream 찾아 forward. 없으면 null (= 자체 tool). write 도구는 거부. */
  async route(toolName: string, args: Record<string, unknown>) {
    const owner = this.upstreams.find((u) => u.owns(toolName));
    if (!owner) return null;
    if (!isUpstreamReadOnly(toolName)) {
      console.error(`[upstream] read-only gateway 차단(허용리스트 외 동사): ${toolName}`);
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] write/미허용 도구는 비활성화됨(read-only gateway): ${toolName}` },
        ],
        isError: true,
      };
    }
    return await owner.callTool(toolName, args);
  }

  /** ping/status 용 */
  statuses() {
    return this.upstreams.map((u) => u.status());
  }

  get ready() {
    return this.initialized;
  }
}

/** 전역 singleton — startup connectAll, createServer 에서 tool aggregate. */
export const upstreamManager = new UpstreamManager();
