/**
 * AsyncLocalStorage 기반 request-scoped AuthContext.
 *
 * HTTP transport 에선 per-request 마다 다른 사용자가 호출 →
 * Express middleware 에서 authStore.run() 안에 transport.handleRequest() 감싸면
 * tool handler 가 getAuth() 로 현재 호출자 확인 가능.
 *
 * stdio transport 에선 process 시작 시 1회 authStore.run() 으로 감쌈.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { AuthContext } from './auth.js';

export const authStore = new AsyncLocalStorage<AuthContext>();

/**
 * 현재 request 의 AuthContext 반환. 없거나 ok=false 면 throw.
 * Tool handler 안에서 호출.
 */
export function getAuth(): AuthContext {
  const auth = authStore.getStore();
  if (!auth || !auth.ok) {
    throw new Error('[context] auth not initialized or not ok');
  }
  return auth;
}

/**
 * 옵션: ok 여부 무관하게 반환. middleware error response 생성 시 사용.
 */
export function getAuthMaybe(): AuthContext | undefined {
  return authStore.getStore();
}
