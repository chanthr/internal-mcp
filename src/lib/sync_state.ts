/**
 * Drive 증분 sync 의 pageToken 영속화 — Supabase((config.data.schema).mcp_sync_state).
 *
 * 예전엔 로컬 파일(.drive_sync_state.json)에 저장했는데, Railway 는 배포마다
 * 컨테이너 filesystem 이 초기화(ephemeral)되어 재배포 시 토큰이 유실 →
 * getStartPageToken 으로 "지금부터" 재시작 → 재배포~다음 전체 reindex 사이의
 * Drive 변경분이 RAG 인덱스에 영구 누락됐다. → DB 로 이전해 재배포에도 유지.
 */
import { getSupabase } from './supabase.js';
import { getConfig } from './config.js';

const STATE_KEY = 'drive';
const SCHEMA = getConfig().data.schema;
const TABLE = 'mcp_sync_state';

export async function getSyncToken(): Promise<string | null> {
  try {
    const { data, error } = await getSupabase()
      .schema(SCHEMA)
      .from(TABLE)
      .select('page_token')
      .eq('key', STATE_KEY)
      .maybeSingle();
    if (error) {
      console.error('[sync_state] getSyncToken failed:', error.message);
      return null;
    }
    return data?.page_token ?? null;
  } catch (e) {
    console.error('[sync_state] getSyncToken threw:', e);
    return null; // 읽기 실패 = 첫 실행처럼 취급 (안전)
  }
}

export async function setSyncToken(token: string): Promise<void> {
  try {
    const { error } = await getSupabase()
      .schema(SCHEMA)
      .from(TABLE)
      .upsert(
        { key: STATE_KEY, page_token: token, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
    if (error) console.error('[sync_state] setSyncToken failed:', error.message);
  } catch (e) {
    console.error('[sync_state] setSyncToken threw:', e);
  }
}
