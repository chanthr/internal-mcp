/**
 * Sign-ins kept in the data directory, and the token each one hands out.
 *
 * A sign-in (Railway, another service's MCP server) is a JSON file only the owner can read: who registered, the
 * refresh token, and the access token in use. An access token lasts about an hour, and many services change the
 * refresh token every time it is used. Every server on this data directory reads the same file (the HTTP server
 * and each stdio session a client starts), so renewing is done by one process at a time and the others read what
 * it wrote. Two processes spending the same refresh token would end the sign-in for both.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLock, releaseLock } from './lock.js';
import { dataDir } from './paths.js';

export interface SignInFile<T> {
  path(): string;
  read(): T | null;
  write(value: T): void;
  forget(): void;
}

/** A file under the data directory, written whole and swapped in so another process never reads half of it. */
export function signInFile<T extends object>(relative: string): SignInFile<T> {
  const path = () => join(dataDir(), relative);
  return {
    path,
    read() {
      try {
        const j = JSON.parse(readFileSync(path(), 'utf8'));
        return j && typeof j === 'object' ? (j as T) : null;
      } catch {
        return null;
      }
    },
    write(value) {
      mkdirSync(dirname(path()), { recursive: true, mode: 0o700 });
      const tmp = `${path()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path());
    },
    forget() {
      rmSync(path(), { force: true });
    },
  };
}

export interface AccessToken {
  value: string;
  /** When it stops working (ms since 1970). Unset: the service did not say, so it is used until refused. */
  expiresAt?: number;
}

/** Good for at least another minute? */
export const stillGood = (t: AccessToken | null | undefined): t is AccessToken => !!t?.value && (t.expiresAt === undefined || t.expiresAt - 60_000 > Date.now());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** OAuth's word for "this refresh token is spent or withdrawn", wherever the error carries it. */
const isInvalidGrant = (e: unknown): boolean => [(e as { code?: unknown })?.code, (e as { errorCode?: unknown })?.errorCode].includes('invalid_grant');

export interface FreshTokenOptions<T extends object> {
  file: SignInFile<T>;
  /** Name of the lock that says "I am renewing this sign-in". */
  lock: string;
  /** The access token in what is saved. */
  token: (saved: T) => AccessToken | null;
  /** Trade the saved refresh token for new tokens and return what to save. Null: there is nothing to renew with. */
  renew: (saved: T) => Promise<T | null>;
  /** What to say when only a new sign-in helps. */
  gone: string;
  /** A token the service has just refused: it is not handed out again, even if its time is not up. */
  rejected?: string;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * The access token of a saved sign-in, renewed when its time is up or when the service refused the last one.
 * Callers in this process asking at the same moment share one renewal; other processes wait for the file.
 */
export function freshToken<T extends object>(opts: FreshTokenOptions<T>): Promise<string> {
  const saved = opts.file.read();
  const t = saved ? opts.token(saved) : null;
  if (stillGood(t) && t.value !== opts.rejected) return Promise.resolve(t.value);
  const key = `${opts.lock}\n${opts.rejected ?? ''}`;
  let running = inFlight.get(key);
  if (!running) {
    running = renewUnderLock(opts).finally(() => inFlight.delete(key));
    inFlight.set(key, running);
  }
  return running;
}

async function renewUnderLock<T extends object>(opts: FreshTokenOptions<T>): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const usable = (saved: T | null): string | null => {
      if (!saved) throw new Error(opts.gone);
      const t = opts.token(saved);
      return stillGood(t) && t.value !== opts.rejected ? t.value : null;
    };
    const seen = usable(opts.file.read());
    if (seen) return seen;
    // Another process is renewing right now: wait for what it writes instead of spending the same refresh token.
    if (!acquireLock(opts.lock, 60_000)) {
      await sleep(250);
      continue;
    }
    try {
      const now = opts.file.read(); // it may have been renewed between the read and the lock
      const already = usable(now);
      if (already) return already;
      let next: T | null;
      try {
        next = await opts.renew(now!);
      } catch (e) {
        if (isInvalidGrant(e)) throw new Error(opts.gone);
        throw e;
      }
      const made = next ? opts.token(next) : null;
      if (!next || !made?.value) throw new Error(opts.gone);
      opts.file.write(next);
      return made.value;
    } finally {
      releaseLock(opts.lock);
    }
  }
  throw new Error('Another process has been renewing this sign-in for too long. Try again.');
}
