/**
 * Supabase service-role client (singleton).
 *
 * Supabase 저장소(store/supabase.ts)만 쓴다. 도구는 저장소 인터페이스(getStore)를 거친다.
 * .env 의 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 로 부트스트랩.
 *
 * 첫 호출 시 client 생성, 이후 재사용. 환경변수 누락 시 throw.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in env. ' +
        'The Supabase store needs both values.'
    );
  }

  // Node 20 (Railway) 은 native WebSocket 이 없어 supabase realtime init 이 throw 한다.
  // realtime 을 쓰진 않지만 createClient 가 RealtimeClient 를 자동 생성하므로, ws 를 transport 로 주입해 우회.
  // (Node 버전 무관 — Railway 가 engines>=22 를 무시하고 Node 20 으로 실행하는 문제를 코드 레벨에서 해결)
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });
  return _client;
}
