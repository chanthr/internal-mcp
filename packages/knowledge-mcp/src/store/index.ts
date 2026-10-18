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

/** Tests only: use this store instead of opening one. */
export function setStoreForTesting(store: Store | null): void {
  _store = store ? Promise.resolve(store) : null;
}

export type { Store } from './types.js';
