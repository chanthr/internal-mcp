/**
 * 직원별 권한 판정 — 도구군(= 플러그인 id)과 AuthContext.scopes(app_users allowed_*)로 도구·채널·폴더를 거른다.
 *
 * 원칙:
 *   - admin 은 모든 scope 무시(전체 허용) — 운영 잠금 방지.
 *   - member(app_users 에 등록된 사용자): 각 차원 scope 가 null/undefined/빈배열이면 그 차원은 전체 허용
 *     (미설정 = 점진 도입). 명시 배열이 있으면 그 안의 것만 허용.
 *   - viewer(app_users 에 없음, 또는 조회 실패): 기본 거부. config access.viewerTools 에 적은 도구군만 허용.
 *     로그인만 통과한 계정이 Drive·Slack·로그 전체를 읽는 것을 막는다.
 *   - 도구군이 없는 도구는 ping 만 허용한다. 플러그인에 속하지 않는 도구가 생겨도 기본 거부.
 * Drive 제외 폴더(PII·계약·HR)는 이 scope 와 별개로 항상 적용된다.
 */
import type { AuthContext } from './auth.js';
import { getConfig } from './config.js';

// 도구군 없이도 항상 허용하는 안전 도구(health check). 명시 화이트리스트.
const NO_SCOPE_TOOLS = new Set<string>(['ping']);

/**
 * 이 도구를 노출·호출해도 되는가. group = 도구가 속한 플러그인 id(registry.groupOf), 없으면 null.
 * admin = 전체, member = allowed_tools(미설정=전체), viewer = config access.viewerTools 로 연 것만.
 */
export function isToolAllowed(auth: AuthContext, name: string, group: string | null): boolean {
  if (auth.role === 'admin') return true;
  if (group === null) return NO_SCOPE_TOOLS.has(name);
  if (auth.role !== 'member') return getConfig().access.viewerTools.includes(group);
  const tools = auth.scopes?.tools;
  if (!tools || tools.length === 0) return true; // 미설정 = 모든 도구군
  return tools.includes(group);
}

/** 허용 Slack 채널 id Set. null = 전체 허용(admin·미설정). */
export function allowedSlackChannels(auth: AuthContext): Set<string> | null {
  if (auth.role === 'admin') return null;
  const ch = auth.scopes?.slackChannels;
  if (!ch || ch.length === 0) return null;
  return new Set(ch);
}

/** 허용 Drive 폴더 path prefix 배열. null = 전체 허용(admin·미설정). */
export function allowedDriveFolders(auth: AuthContext): string[] | null {
  if (auth.role === 'admin') return null;
  const f = auth.scopes?.driveFolders;
  if (!f || f.length === 0) return null;
  return f;
}

/**
 * path 가 허용 폴더 prefix 하위인가. prefixes null = 전체 허용.
 * path 예: "개발문서/backend/..." · "01_고객사/Acme/제안서.pptx".
 * prefix 예: "01_고객사" → 그 하위 전부 허용. 정확 일치 또는 "prefix/" 로 시작.
 */
export function isPathInScope(path: string, prefixes: string[] | null): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  const norm = String(path).replace(/^\/+/, '');
  return prefixes.some((p) => {
    const pp = String(p).replace(/^\/+|\/+$/g, '');
    if (!pp) return false;
    return norm === pp || norm.startsWith(pp + '/');
  });
}
