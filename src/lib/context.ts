/**
 * AsyncLocalStorage 기반 request-scoped AuthContext.
 *
 * HTTP transport 에선 per-request 마다 다른 사용자가 호출 →
 * Express middleware 에서 authStore.run() 안에 transport.handleRequest() 감싸면
 * tool handler 가 getAuth() 로 현재 호출자 확인 가능.
 *
 * stdio transport 에선 한 프로세스 = 한 사용자라 setProcessAuth() 로 프로세스 전체 값을 둔다.
 * (enterWith 는 그 뒤에 생기는 비동기 작업에만 전파되고, stdin 핸들은 그 전에 만들어져
 *  도구 호출 콜백에서 getStore() 가 비어 모든 호출이 거부됐다.)
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { AuthContext } from './auth.js';

export const authStore = new AsyncLocalStorage<AuthContext>();

// stdio 전용 프로세스 단위 인증. HTTP 에서는 설정하지 않는다(요청마다 authStore.run).
let _processAuth: AuthContext | undefined;

/** stdio 시작 시 1회 — 이 프로세스의 모든 도구 호출이 이 인증으로 처리된다. */
export function setProcessAuth(auth: AuthContext): void {
  _processAuth = auth;
}

/**
 * 현재 request 의 AuthContext 반환. 없거나 ok=false 면 throw.
 * Tool handler 안에서 호출.
 */
export function getAuth(): AuthContext {
  const auth = authStore.getStore() ?? _processAuth;
  if (!auth || !auth.ok) {
    throw new Error('[context] auth not initialized or not ok');
  }
  return auth;
}

/**
 * 옵션: ok 여부 무관하게 반환. middleware error response 생성 시 사용.
 */
export function getAuthMaybe(): AuthContext | undefined {
  return authStore.getStore() ?? _processAuth;
}
