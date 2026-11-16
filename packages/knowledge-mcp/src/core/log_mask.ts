/**
 * Global log masking: hides secrets in console.* output.
 *
 * Why: when whole error objects are logged (gaxios/fetch request config and Authorization headers, Qdrant, Slack and
 * upstream errors, uncaughtException/unhandledRejection stacks), tokens and API keys can end up in the Railway logs
 * in plain text. Instead of plugging each leak point one by one, console entry is intercepted in one place and
 * masked there (broad and defensive).
 *
 * Two kinds of masking:
 *  1) Concrete values: values of sensitive process.env keys (length >= 10) are removed by exact match. The most
 *     reliable (it erases the key itself).
 *  2) Patterns: common secret shapes such as sk-/AIza/Bearer/xox/gh*_/JWT/api_key=/PEM private key.
 *
 * fail-open: if masking throws, the original log line is still written (a security feature must not break logging).
 */
import { inspect } from 'util';

const REDACTED = '[REDACTED]';

/** Env key names whose value is likely a secret. PAT matches only as a whole word (avoids false hits like PATH). */
const SECRET_KEY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|REFRESH|SIGNING)|(^|_)PAT($|_)/i;
/** Avoids false positives: even if the key name matches above, common non-secret values are skipped */
const SAFE_VALUES = new Set(['true', 'false', 'production', 'development', 'http', 'https', 'none', 'null']);

let _installed = false;
let _envSecretRe: RegExp | null = null;
let _envSecretCount = 0;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collects the concrete secret values to mask from process.env (longest first, so longer values are replaced first). */
function collectEnvSecrets(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 10) continue;
    if (SAFE_VALUES.has(v.toLowerCase())) continue;
    if (SECRET_KEY_NAME.test(k)) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Replaces secrets in a string (concrete values + common patterns) with [REDACTED]. */
export function maskString(input: string): string {
  if (!input) return input;
  let out = input;
  // 1) concrete env values (most reliable)
  if (_envSecretRe) out = out.replace(_envSecretRe, REDACTED);
  // 2) common patterns
  out = out.replace(
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, REDACTED); // JWT
  out = out.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|xox[bpsar]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|kmcp_[A-Za-z0-9_-]{20,})/g,
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
 * Replaces console.{log,error,warn,info,debug} with masking wrappers (once).
 * Must be called right after .env is read and before any other logic, so that every later log is masked (bootstrap.ts).
 * A value that must appear on screen as is (a new API key) is written with process.stdout.write, not console.
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
        orig(...args); // fail-open: a masking failure does not block logging
      }
    };
  }
}

/** For the one-line boot log: the number of env secrets being masked. */
export function maskedSecretCount(): number {
  return _envSecretCount;
}
