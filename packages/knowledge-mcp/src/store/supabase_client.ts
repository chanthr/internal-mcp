/**
 * Supabase service-role client (singleton).
 *
 * Used only by the Supabase store (store/supabase.ts). Tools go through the store interface (getStore).
 * Bootstrapped from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
 *
 * The client is created on the first call and reused afterwards. Throws if the environment variables are missing.
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

  // Node 20 (Railway) has no native WebSocket, so supabase realtime init throws.
  // Realtime is not used, but createClient creates a RealtimeClient automatically, so ws is injected as the transport
  // to get around it.
  // (Works on any Node version. This fixes at code level the case where Railway ignores engines>=22 and runs Node 20.)
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });
  return _client;
}
