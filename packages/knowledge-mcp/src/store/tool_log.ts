/**
 * Tool-call audit log — who called which tool, when, and whether it failed.
 * Best effort: never blocks or fails the tool response. Arguments are not stored (they may hold secrets).
 */
import type { AuthContext } from '../core/auth.js';
import { getStore } from './index.js';

export function logToolCall(params: {
  tool: string;
  auth: AuthContext | undefined;
  ok: boolean;
  error: string | null;
  durationMs: number;
}): void {
  const { tool, auth, ok, error, durationMs } = params;
  getStore()
    .then((s) => s.logToolCall({ tool, email: auth?.email ?? null, role: auth?.role ?? null, ok, error, durationMs }))
    .catch((e: unknown) => console.error('[tool-log] store unavailable:', e instanceof Error ? e.message : e));
}
