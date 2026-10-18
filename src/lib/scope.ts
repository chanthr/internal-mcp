/**
 * 직원별 리소스 스코프 판정 — AuthContext.scopes(app_users allowed_*)로 도구·채널·폴더 필터.
 *
 * 원칙:
 *   - admin role 은 모든 scope 무시(전체 허용) — 운영 잠금 방지.
 *   - engineer(app_users 에 등록된 사용자): 각 차원 scope 가 null/undefined/빈배열이면 그 차원은 전체 허용
 *     (미설정 = 점진 도입). 명시 배열이 있으면 그 안의 것만 허용.
 *   - viewer(app_users 에 없음, 또는 조회 실패): 기본 거부. config access.viewerTools 에 적은 도구군만 허용.
 *     로그인만 통과한 계정이 Drive·Slack·로그 전체를 읽는 것을 막는다.
 * 전역 제외(EXCLUDED_FOLDER_NAMES: PII·계약·HR)는 이 scope 와 별개로 항상 적용된다.
 */
import type { AuthContext } from './auth.js';
import { getConfig } from './config.js';

// 그룹(scope 키)이 없어도 항상 허용하는 안전 도구(무권한 health check 등). 명시 화이트리스트 —
// 신규 도구가 toolGroup 분류 없이 추가되면 default-deny 되도록(미분류 = 통과를 막음).
const NO_SCOPE_TOOLS = new Set<string>(['ping']);

/** 도구 이름 → 도구군(scope 키). null = 그룹 미분류. */
export function toolGroup(name: string): string | null {
  if (name.startsWith('slack_')) return 'slack';
  if (name.startsWith('github_') || name === 'repo_tree') return 'github';
  if (name.startsWith('railway_')) return 'railway';
  if (
    name === 'search_drive' ||
    name === 'read_drive_file' ||
    name === 'list_drive_folder' ||
    name === 'semantic_search_drive'
  ) {
    return 'drive';
  }
  return null;
}

/** 이 도구를 호출/노출해도 되는가. admin = 전체, engineer = scope(미설정=전체), viewer = config 로 연 것만. */
export function isToolAllowed(auth: AuthContext, name: string): boolean {
  const g = toolGroup(name);
  if (auth.role === 'admin') return true;
  if (g === null) {
    // 미분류 도구: 명시 안전 도구(ping)만 허용, 나머지는 deny(default-deny).
    // 신규 민감 도구가 toolGroup 분류 없이 추가돼도 scope 제한 직원에게 새지 않게 함.
    return NO_SCOPE_TOOLS.has(name);
  }
  // engineer 가 아니면(viewer·role 없음) 기본 거부 — 운영자가 viewerTools 로 연 도구군만.
  if (auth.role !== 'engineer') return (getConfig().access.viewerTools as readonly string[]).includes(g);
  const tools = auth.scopes?.tools;
  if (!tools || tools.length === 0) return true; // 미설정 = 분류 도구 전체
  return tools.includes(g);
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
