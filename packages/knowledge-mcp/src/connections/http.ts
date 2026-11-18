/**
 * HTTP connection for declared tools: one API request per tool.
 *
 * What a caller's parameters can and cannot do:
 *   - The host and the base path are fixed by the connection. A parameter fills a path segment (URL-encoded), a
 *     query value, a header value or a field of the JSON body; it cannot change where the request goes. The final
 *     URL is checked against the base URL before anything is sent.
 *   - Redirects are not followed: the request carries the connection's credentials, and a redirect chooses a new
 *     destination for them.
 *   - The response is read up to a size limit and the call has a time limit.
 *
 * Secrets come from the environment (`${ENV_NAME}` in header and query values). They are kept out of what the
 * caller sees: errors name the host and path only, and a secret this request used is masked wherever it shows up
 * in the answer (an API that echoes the request back, an error page that prints the headers).
 *
 * A template is filled in one pass, `${ENV_NAME}` from the environment and `{name}` from the call. What was put in
 * is never read again, so a parameter whose value is the text "${TOKEN}" stays that text.
 */
import { ToolError } from '../plugin/define.js';
import { clip } from './format.js';
import { DEFAULT_HTTP_MAX_BYTES, DEFAULT_HTTP_TIMEOUT_MS, type HttpConnection, type RequestSpec } from './schema.js';

type Args = Record<string, unknown>;
const absent = (v: unknown) => v === undefined || v === null;
const ONLY_PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * A header or query template with `${ENV_NAME}` and `{name}` filled in, in one pass. Env values used are added to
 * `secrets`, so they can be masked in the answer.
 */
export function fillTemplate(text: string, args: Args, env: NodeJS.ProcessEnv, secrets?: Set<string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, envName: string | undefined, param: string | undefined) => {
    if (envName !== undefined) {
      const v = env[envName];
      if (v === undefined || v === '') throw new ToolError(`the env var ${envName} is not set`);
      secrets?.add(v);
      return v;
    }
    return absent(args[param!]) ? '' : String(args[param!]);
  });
}

/** Text with every secret of this request masked, in plain and in URL-encoded form. */
export function mask(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 4) continue; // too short to tell from ordinary text
    out = out.split(s).join('***');
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join('***');
  }
  return out;
}

/** `{name}` → the parameter as text (nothing when absent). */
const fillText = (text: string, args: Args): string => text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => (absent(args[n]) ? '' : String(args[n])));

/** The path with each `{name}` replaced by one URL-encoded segment. */
export function fillPath(path: string, args: Args): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => {
    const v = args[n];
    const s = absent(v) ? '' : String(v);
    // "." and ".." are path instructions, not names: /items/.. is /items' parent. Empty would drop the segment.
    if (s === '' || s === '.' || s === '..') throw new ToolError(`"${n}" cannot be empty, "." or ".."`);
    return encodeURIComponent(s);
  });
}

/** The JSON body with parameters put in. A string that is only `{name}` takes the parameter's own type. */
export function fillBody(template: unknown, args: Args): unknown {
  const DROP = Symbol('drop');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const only = ONLY_PLACEHOLDER.exec(v);
      if (only) return absent(args[only[1]]) ? DROP : args[only[1]];
      return fillText(v, args);
    }
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== DROP);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const y = walk(x);
        if (y !== DROP) out[k] = y; // an absent optional parameter leaves its field out
      }
      return out;
    }
    return v;
  };
  const out = walk(template);
  return out === DROP ? undefined : out;
}

/** The URL of a request: base + path + query. Throws when it would leave the connection's base URL. */
export function buildUrl(
  conn: Pick<HttpConnection, 'baseUrl' | 'query'>,
  request: Pick<RequestSpec, 'path' | 'query'>,
  args: Args,
  env: NodeJS.ProcessEnv = process.env,
  secrets?: Set<string>,
): URL {
  const base = new URL(conn.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin + basePath + fillPath(request.path, args));
  if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
    throw new ToolError('the request would leave the base URL of its connection');
  }
  for (const [k, v] of Object.entries(conn.query ?? {})) url.searchParams.set(k, fillTemplate(v, {}, env, secrets));
  for (const [k, v] of Object.entries(request.query ?? {})) {
    const only = ONLY_PLACEHOLDER.exec(v);
    if (only && absent(args[only[1]])) continue; // an optional parameter that was not given
    url.searchParams.set(k, fillTemplate(v, args, env, secrets));
  }
  return url;
}

/** Read a response body up to `maxBytes`. */
async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

/** One part of a JSON value by dot path ("data.items", "results.0"). */
function pick(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) throw new ToolError(`the API response has no "${path}" (the tool's \`pick\`)`);
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export interface HttpCall {
  /** Connection name, for messages. */
  name: string;
  connection: HttpConnection;
  request: RequestSpec;
  args: Args;
  timeoutMs?: number;
}

/** Send the request and return what the model should read. */
export async function callHttp(call: HttpCall, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { connection: conn, request, args } = call;
  const secrets = new Set<string>();
  const url = buildUrl(conn, request, args, env, secrets);
  const where = `${url.host}${url.pathname}`; // never the query string: it may hold a key

  const headers = new Headers();
  const setHeader = (k: string, v: string) => {
    try {
      headers.set(k, v);
    } catch {
      // The runtime's own message quotes the whole value, and the value can hold a secret.
      throw new ToolError(`the value for the header "${k}" holds a character that is not allowed in a header (a line break, for example)`);
    }
  };
  for (const [k, v] of Object.entries(conn.headers ?? {})) setHeader(k, fillTemplate(v, {}, env, secrets));
  for (const [k, v] of Object.entries(request.headers ?? {})) setHeader(k, fillTemplate(v, args, env, secrets));
  if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.8, */*;q=0.5');

  let body: string | undefined;
  if (request.body !== undefined && request.method !== 'GET') {
    body = JSON.stringify(fillBody(request.body, args));
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }

  const timeoutMs = call.timeoutMs ?? conn.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string; message?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ToolError(`the API of "${call.name}" did not answer within ${timeoutMs / 1000}s (${where})`);
    throw new ToolError(`cannot reach the API of "${call.name}" (${where}): ${err.cause?.code ?? err.cause?.message ?? 'network error'}`);
  }

  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    let to = '';
    try {
      const loc = new URL(res.headers.get('location') ?? '', url);
      to = ` to ${loc.host}${loc.pathname}`;
    } catch {
      /* no usable Location */
    }
    throw new ToolError(`the API answered with a redirect (HTTP ${res.status}${to}). Redirects are not followed; set the connection's baseUrl to the final address`);
  }

  const { text, truncated } = await readLimited(res, conn.maxBytes ?? DEFAULT_HTTP_MAX_BYTES);
  if (!res.ok) throw new ToolError(`the API answered HTTP ${res.status} (${where}): ${mask(text.slice(0, 500), secrets).trim() || res.statusText || 'no body'}`);
  if (res.status === 204 || text.length === 0) return `Done (HTTP ${res.status}, empty response).`;

  const note = truncated ? `\n… [the response was larger than ${conn.maxBytes ?? DEFAULT_HTTP_MAX_BYTES} bytes and was cut; do not treat it as complete]` : '';
  const looksJson = /json/i.test(res.headers.get('content-type') ?? '') || /^\s*[[{]/.test(text);
  if (looksJson && !truncated) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return mask(clip(text), secrets);
    }
    if (request.pick) value = pick(value, request.pick);
    return mask(clip(typeof value === 'string' ? value : JSON.stringify(value)), secrets);
  }
  return mask(clip(text), secrets) + note;
}

/**
 * Is the API there? One GET of the base URL with the connection's headers. Any answer shows the host is reachable;
 * 401 and 403 mean the credentials were refused.
 */
export async function pingHttp(name: string, conn: HttpConnection, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const url = buildUrl(conn, { path: '/' }, {}, env);
  const headers = new Headers();
  for (const [k, v] of Object.entries(conn.headers ?? {})) headers.set(k, fillTemplate(v, {}, env));
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(conn.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 10_000)) });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string; message?: string } };
    throw new Error(err.name === 'TimeoutError' ? `${url.host} did not answer in time` : `cannot reach ${url.host}: ${err.cause?.code ?? err.cause?.message ?? 'network error'}`);
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) throw new Error(`${url.host} refused the credentials (HTTP ${res.status} at the base URL)`);
  return `${url.host} answers (HTTP ${res.status} at the base URL)`;
}
