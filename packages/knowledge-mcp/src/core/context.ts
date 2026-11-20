/**
 * Request-scoped AuthContext, based on AsyncLocalStorage.
 *
 * On the HTTP transport a different user may call on each request, so
 * the Express middleware wraps transport.handleRequest() in authStore.run(), and
 * a tool handler can then identify the current caller with getAuth().
 *
 * On the stdio transport one process = one user, so setProcessAuth() sets a process-wide value.
 * (enterWith only propagates to async work created after it, and the stdin handle is created before that,
 *  so getStore() was empty in tool call callbacks and every call was rejected.)
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { AuthContext } from './auth.js';

export const authStore = new AsyncLocalStorage<AuthContext>();

/** The caller a call from the console runs as: the owner at this machine, as the admin (admin/routes.ts runAsConsole). */
export const CONSOLE_EMAIL = 'console@localhost';

// Process-wide auth for stdio only. Not set on HTTP (authStore.run per request).
let _processAuth: AuthContext | undefined;

/** Called once when stdio starts: every tool call in this process is handled with this auth. */
export function setProcessAuth(auth: AuthContext): void {
  _processAuth = auth;
}

/**
 * Returns the AuthContext of the current request. Throws if it is missing or ok=false.
 * Call it inside a tool handler.
 */
export function getAuth(): AuthContext {
  const auth = authStore.getStore() ?? _processAuth;
  if (!auth || !auth.ok) {
    throw new Error('[context] auth not initialized or not ok');
  }
  return auth;
}

/**
 * Optional: returns it whether ok or not. Used when building a middleware error response.
 */
export function getAuthMaybe(): AuthContext | undefined {
  return authStore.getStore() ?? _processAuth;
}
