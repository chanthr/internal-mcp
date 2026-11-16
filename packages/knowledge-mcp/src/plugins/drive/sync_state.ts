/**
 * Persists the pageToken of the Drive incremental sync in the store plugin state (namespace "drive", key "pageToken").
 *
 * A local file disappears on every container redeploy (ephemeral), so the Drive changes between a redeploy and the
 * next full reindex were permanently missing from the index. The token is therefore kept in the store (the SQLite
 * file on a volume, or Supabase).
 *
 * A failed read throws. It used to be treated as null (= first run) and overwritten with a "from now on" token, so a
 * single temporary outage permanently lost the changes in between. Now only that cycle is skipped and the next cycle
 * reads again.
 */
import { getStore } from '../../store/index.js';

const NS = 'drive';
const KEY = 'pageToken';

/** The stored token. null if there is none (first run). Store errors throw. */
export async function getSyncToken(): Promise<string | null> {
  const v = await (await getStore()).getState(NS, KEY);
  return typeof v === 'string' && v ? v : null;
}

export async function setSyncToken(token: string): Promise<void> {
  try {
    await (await getStore()).setState(NS, KEY, token);
  } catch (e) {
    console.error('[sync_state] setSyncToken failed:', e instanceof Error ? e.message : e);
  }
}

// ── Retry list for failed files ──
// When one file fails (OpenAI quota exhausted, Qdrant timeout) the pageToken still advances (otherwise one broken file
// would stall the sync forever). Instead the failed fileId is added here and retried in the next cycle. After ten
// failures it is dropped and logged (the next full reindex picks it up).
const RETRY_KEY = 'retry';
export const MAX_RETRY_ATTEMPTS = 10;
const MAX_RETRY_FILES = 1000;

/** fileId → number of failures so far. */
export async function getRetryList(): Promise<Record<string, number>> {
  const v = await (await getStore()).getState(NS, RETRY_KEY);
  return v && typeof v === 'object' ? (v as Record<string, number>) : {};
}

export async function setRetryList(list: Record<string, number>): Promise<void> {
  const entries = Object.entries(list).slice(-MAX_RETRY_FILES);
  try {
    await (await getStore()).setState(NS, RETRY_KEY, Object.fromEntries(entries));
  } catch (e) {
    console.error('[sync_state] setRetryList failed:', e instanceof Error ? e.message : e);
  }
}
