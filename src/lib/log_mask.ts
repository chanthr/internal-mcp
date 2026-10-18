/**
 * 전역 로그 마스킹 — console.* 출력에서 시크릿을 가린다.
 *
 * 왜: 에러 객체(gaxios/fetch 의 request config·Authorization 헤더, Qdrant·Slack·upstream
 * 에러, uncaughtException/unhandledRejection stack)를 통째로 로깅할 때 토큰·API 키가 평문으로
 * Railway 로그에 남을 수 있다. 노출 지점을 하나씩 막는 대신 console 진입을 한 곳에서 가로채
 * 마스킹한다(포괄·방어적).
 *
 * 2축 마스킹:
 *  1) 구체값 — process.env 의 민감 키 값(길이 ≥ 10)을 정확 매칭으로 제거. 가장 확실(키 자체를 지움).
 *  2) 패턴   — sk-/AIza/Bearer/xox/gh*_/JWT/api_key=/PEM private key 등 일반 시크릿 형태.
 *
 * fail-open: 마스킹 중 오류가 나도 원본 로깅은 보장한다(보안 기능이 로깅 자체를 깨면 안 됨).
 */
import { inspect } from 'util';

const REDACTED = '[REDACTED]';

/** 값이 시크릿일 가능성이 큰 env 키 이름. PAT 은 단어 단위로만(PATH 같은 이름 오탐 방지). */
const SECRET_KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|REFRESH|SIGNING)|(^|_)PAT($|_)/i;
/** false-positive 방지 — 키 이름이 위에 걸려도 값이 흔한 비밀-아님이면 제외 */
const SAFE_VALUES = new Set(['true', 'false', 'production', 'development', 'http', 'https', 'none', 'null']);

let _installed = false;
let _envSecretRe: RegExp | null = null;
let _envSecretCount = 0;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** process.env 에서 마스킹할 구체 시크릿 값을 모은다 (길이 내림차순 — 긴 값 먼저 치환). */
function collectEnvSecrets(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 10) continue;
    if (SAFE_VALUES.has(v.toLowerCase())) continue;
    if (SECRET_KEY_NAME.test(k)) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** 문자열에서 시크릿(구체값 + 일반 패턴)을 [REDACTED] 로 가린다. */
export function maskString(input: string): string {
  if (!input) return input;
  let out = input;
  // 1) env 구체값 (가장 확실)
  if (_envSecretRe) out = out.replace(_envSecretRe, REDACTED);
  // 2) 일반 패턴
  out = out.replace(
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, REDACTED); // JWT
  out = out.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|xox[bpsar]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    REDACTED,
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `Bearer ${REDACTED}`);
  out = out.replace(
    /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)(["':=\s]+)[A-Za-z0-9._-]{8,}/gi,
    (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );
  return out;
}

/**
 * console.{log,error,warn,info,debug} 를 마스킹 래퍼로 교체 (1회).
 * loadEnv() 직후·다른 로직 전에 호출해야 이후 모든 로그가 마스킹된다.
 */
export function installLogMasking(): void {
  if (_installed) return;
  _installed = true;

  const secrets = collectEnvSecrets();
  _envSecretCount = secrets.length;
  _envSecretRe = secrets.length ? new RegExp(secrets.map(escapeRegExp).join('|'), 'g') : null;

  const methods = ['log', 'error', 'warn', 'info', 'debug'] as const;
  for (const m of methods) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      try {
        const masked = args.map((a) =>
          typeof a === 'string'
            ? maskString(a)
            : maskString(inspect(a, { depth: 4, breakLength: Infinity })),
        );
        orig(...masked);
      } catch {
        orig(...args); // fail-open — 마스킹 실패가 로깅을 막지 않음
      }
    };
  }

  console.error(`[log-mask] 설치 완료 — env 시크릿 ${_envSecretCount}개 + 일반 패턴 마스킹 활성`);
}
