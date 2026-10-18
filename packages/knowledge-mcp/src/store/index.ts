/**
 * Store selection. MCP_STORE=sqlite|supabase picks one explicitly. Without it, Supabase is used when
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (installs from before 0.3 keep working), else SQLite.
 */
import type { Store } from './types.js';

let _store: Promise<Store> | null = null;

export function storeKind(): 'sqlite' | 'supabase' {
  const explicit = (process.env.MCP_STORE ?? '').trim().toLowerCase();
  if (explicit === 'sqlite' || explicit === 'supabase') return explicit;
  if (explicit) throw new Error(`[store] MCP_STORE must be "sqlite" or "supabase", got "${explicit}"`);
  return process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'sqlite';
}

/** The process-wide store, opened on first use. */
export function getStore(): Promise<Store> {
  if (!_store) {
    _store = (async () => {
      if (storeKind() === 'supabase') {
        const { SupabaseStore } = await import('./supabase.js');
        return new SupabaseStore();
      }
      const { SqliteStore } = await import('./sqlite.js');
      return SqliteStore.open();
    })();
    _store.catch(() => {
      _store = null; // let the next call retry instead of caching the failure
    });
  }
  return _store;
}

/**
 * Days of tool-call log to keep, or null to keep everything. MCP_TOOL_LOG_DAYS wins; without it SQLite keeps 90 days
 * and Supabase keeps everything (its log may feed other tools, so it is only pruned when you ask).
 */
export function toolLogRetentionDays(kind: 'sqlite' | 'supabase'): number | null {
  const raw = process.env.MCP_TOOL_LOG_DAYS;
  if (raw === undefined || raw.trim() === '') return kind === 'sqlite' ? 90 : null;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Prune the tool-call log now and then once a day, by toolLogRetentionDays. Returns a stop function.
 * The timer is unref'd so it never keeps the process alive. Failures are logged, never thrown.
 */
export function scheduleToolLogPrune(store: Store): () => void {
  const days = toolLogRetentionDays(store.kind);
  if (days === null) return () => {};
  const prune = (): void => {
    store.pruneToolCalls(days).then(
      (n) => {
        if (n > 0) console.error(`[tool-log] removed ${n} rows older than ${days} days`);
      },
      (e: unknown) => console.error('[tool-log] prune failed:', e instanceof Error ? e.message : e),
    );
  };
  prune();
  const timer = setInterval(prune, 86_400_000);
  timer.unref();
  return () => clearInterval(timer);
}

export type { Store } from './types.js';
