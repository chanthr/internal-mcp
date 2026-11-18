/**
 * Who may open the local console.
 *
 * The console changes settings and holds the forms where secrets are typed, so it is closed to everything but a
 * browser on the same machine that knows a token:
 *
 *   0. It is there only when a person started the server in a terminal (or asked for it with
 *      KNOWLEDGE_CONSOLE=on). A service, a container and a process manager start the server without one.
 *   1. The request must arrive from this machine (loopback), and not through a proxy that says so. A server
 *      behind a proxy on the same machine sees every visitor as 127.0.0.1; the forwarding headers and the Host
 *      check below keep those out when the proxy sets them. A proxy that sets neither (nginx's plain proxy_pass)
 *      cannot be told from a local browser: that is what rule 0 and the token are for.
 *   2. The Host header must be localhost. A web page elsewhere can make a browser resolve its own name to
 *      127.0.0.1 (DNS rebinding); its requests then carry that other name.
 *   3. The API needs the console token in the Authorization header. A page from another site cannot add that
 *      header without the browser asking this server first (CORS), and this server never says yes.
 *   4. The API answers its own page only: a request a browser marks as coming from another site, or from a page
 *      under another name (this server reached through a public address), is refused before the token is looked at.
 *
 * The token is made once per data directory and kept in a file only the owner can read. The start-up line prints
 * the console address with the token in the URL fragment, which browsers do not send to servers or put in logs.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { dataDir } from '../core/paths.js';

/**
 * Is the console served? KNOWLEDGE_CONSOLE=on or off decides it. Unset, it is served when the server was started
 * in a terminal: that is a person at this machine, not a deployment. `tty` is for tests.
 */
export function consoleEnabled(env: NodeJS.ProcessEnv = process.env, tty: boolean = !!(process.stdout.isTTY || process.stderr.isTTY)): boolean {
  const setting = (env.KNOWLEDGE_CONSOLE ?? '').trim().toLowerCase();
  if (setting === 'off' || setting === 'false' || setting === '0') return false;
  if (setting === 'on' || setting === 'true' || setting === '1') return true;
  return tty;
}

let _token: string | undefined;

/** The console token of this data directory (created on first use). */
export function consoleToken(): string {
  if (_token) return _token;
  const dir = dataDir();
  const path = join(dir, 'console-token');
  if (existsSync(path) && privateToOwner(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved.length >= 24) return (_token = saved);
  }
  // No file, or one that somebody else could read or wrote: a token that may be known is not a token.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('base64url');
  try {
    rmSync(path, { force: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  } catch (e) {
    // The file cannot be replaced (it is not ours). The token then lives for this run only: the address printed
    // at start still opens the console.
    console.error(`[knowledge-mcp] the console token could not be saved to ${path} (${e instanceof Error ? e.message : String(e)}); it is valid until the server stops`);
  }
  return (_token = token);
}

/** Is this file ours, and readable by nobody else? (Windows has no such bits: the data folder's own rules apply.) */
function privateToOwner(path: string): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  try {
    const st = lstatSync(path);
    return st.isFile() && st.uid === process.getuid() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Why this request may not reach the console, or null when it may. */
export function refusal(req: Pick<Request, 'socket' | 'headers'>): string | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return 'The console only answers on the machine the server runs on.';
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return 'The console is not served through a proxy.';
  if (!LOCAL_HOST.test(String(req.headers.host ?? ''))) return 'Open the console as http://localhost.';
  return null;
}

/** Everything under /console: this machine only. */
export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const why = refusal(req);
  if (why) {
    res.status(403).type('text/plain').send(why);
    return;
  }
  next();
}

/**
 * Does a browser say this request comes from somewhere other than the console page itself?
 * Browsers add Sec-Fetch-Site to every request and Origin to every request that changes something. A program
 * (curl, a test) sends neither and is judged by the token alone.
 */
export function foreignPage(headers: Request['headers']): boolean {
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = String(headers.origin ?? '');
  if (!origin) return false;
  try {
    return !LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return true; // "null" and anything else that is not an address
  }
}

/** The API: its own page only, and the console token as a bearer token. */
export function tokenRequired(req: Request, res: Response, next: NextFunction): void {
  if (foreignPage(req.headers)) {
    res.status(403).json({ error: 'The console API only answers the console page, opened as http://localhost.' });
    return;
  }
  const header = String(req.headers.authorization ?? '');
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  const wanted = Buffer.from(consoleToken());
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    res.status(401).json({ error: 'Open the console from the address the server printed when it started. It carries the access token.' });
    return;
  }
  next();
}
