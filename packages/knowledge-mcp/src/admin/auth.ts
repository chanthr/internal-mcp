/**
 * Who may open the local console.
 *
 * The console changes settings and holds the forms where secrets are typed, so it is closed to everything but a
 * browser on the same machine that knows a token:
 *
 *   1. The request must arrive from this machine (loopback), and not through a proxy. A server deployed behind
 *      nginx sees every visitor as 127.0.0.1; the forwarding headers and the Host check below keep those out.
 *   2. The Host header must be localhost. A web page elsewhere can make a browser resolve its own name to
 *      127.0.0.1 (DNS rebinding); its requests then carry that other name.
 *   3. The API needs the console token in the Authorization header. A page from another site cannot add that
 *      header without the browser asking this server first (CORS), and this server never says yes.
 *
 * The token is made once per data directory and kept in a file only the owner can read. The start-up line prints
 * the console address with the token in the URL fragment, which browsers do not send to servers or put in logs.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { dataDir } from '../core/paths.js';

/** The console is on unless KNOWLEDGE_CONSOLE=off. It only ever answers on this machine. */
export function consoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KNOWLEDGE_CONSOLE ?? 'local').trim().toLowerCase() !== 'off';
}

let _token: string | undefined;

/** The console token of this data directory (created on first use). */
export function consoleToken(): string {
  if (_token) return _token;
  const dir = dataDir();
  const path = join(dir, 'console-token');
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved.length >= 24) return (_token = saved);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return (_token = token);
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

/** The API: the console token as a bearer token. */
export function tokenRequired(req: Request, res: Response, next: NextFunction): void {
  const header = String(req.headers.authorization ?? '');
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  const wanted = Buffer.from(consoleToken());
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    res.status(401).json({ error: 'Open the console from the address the server printed when it started. It carries the access token.' });
    return;
  }
  next();
}
