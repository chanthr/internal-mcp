/**
 * 내부 MCP 도구 호출 로그 — (config.data.schema).mcp_tool_calls.
 *
 * 다중 사용자 환경에서 누가·언제·무슨 도구를 호출하고 어디서 실패했는지 영속 추적.
 * best-effort: 로깅 실패가 도구 응답을 절대 막지 않는다(fire-and-forget, 에러는 console 으로만).
 * ⚠️ args 값은 저장하지 않는다(read_secret 등 민감정보 보호) — 도구명·호출자·성공/실패만.
 */
import { getSupabase } from './supabase.js';
import { getConfig } from './config.js';
import type { AuthContext } from './auth.js';

export function logToolCall(params: {
  tool: string;
  auth: AuthContext | undefined;
  ok: boolean;
  error: string | null;
  durationMs: number;
}): void {
  const { tool, auth, ok, error, durationMs } = params;
  // best-effort 불변식 보호: getSupabase()는 env 미설정 시 *동기* throw 한다. logToolCall 은
  // 도구 dispatch try/catch 밖(index.ts)에서 불려, 동기 throw 가 transport 로 누수해 응답을
  // 막을 수 있다. 전체를 try/catch 로 감싸 로깅 실패가 절대 응답을 막지 않게 한다.
  try {
    void getSupabase()
      .schema(getConfig().data.schema)
      .from('mcp_tool_calls')
      .insert({
        tool,
        email: auth?.email ?? null,
        role: auth?.role ?? null,
        ok,
        error: error ? error.slice(0, 2000) : null,
        duration_ms: durationMs,
        source: 'knowledge-mcp',
      })
      .then(
        ({ error: e }) => { if (e) console.error('[tool-log] insert 실패:', e.message); },
        (e: unknown) => console.error('[tool-log] insert 예외:', e instanceof Error ? e.message : e),
      );
  } catch (e) {
    console.error('[tool-log] 동기 실패(무시):', e instanceof Error ? e.message : e);
  }
}
