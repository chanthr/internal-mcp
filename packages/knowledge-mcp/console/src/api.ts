/**
 * Talks to the console API of the server this page came from.
 *
 * The access token arrives once in the address (…/console/#token=…, the part a browser keeps to itself), is kept
 * in this browser's storage for this address only, and is taken out of the address bar. Every call sends it as a
 * header.
 */

const KEY = 'knowledge-mcp-console-token';

/**
 * A token in the address (…/console/#token=…) is taken out of the address bar and tried on the server. It replaces
 * the token this browser has only when the server accepts it: any site can send a browser to this address with a
 * token of its own making, and that must not cost the person their access. Returns true when a new token is in use.
 */
export async function takeTokenFromAddress(): Promise<boolean> {
  const m = /[#&]token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (m[1] === token()) return false;
  let accepted = false;
  try {
    accepted = (await fetch('./api/state', { headers: { Authorization: `Bearer ${m[1]}` } })).ok;
  } catch {
    /* the server is not answering: keep what we have */
  }
  if (accepted) setToken(m[1]);
  return accepted;
}

/** Fired on the window when the server refuses the token, so the page asks for one instead of showing errors. */
export const REFUSED = 'knowledge-mcp-console-refused';

let memoryToken: string | null = null;
export function token(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = localStorage.getItem(KEY);
  } catch {
    /* storage is off */
  }
  return memoryToken;
}
export function setToken(value: string): void {
  memoryToken = value.trim();
  try {
    localStorage.setItem(KEY, memoryToken);
  } catch {
    /* storage is off */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`./api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token() ?? ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) window.dispatchEvent(new Event(REFUSED));
  if (!res.ok) throw new ApiError((json as { error?: string } | null)?.error ?? (text || `The server answered ${res.status}.`), res.status);
  return json as T;
}

// ── What the API returns ──

export interface PluginStatus {
  id: string;
  description?: string;
  enabled: boolean;
  reason?: string;
  tools: Array<{ name: string; enabled: boolean; reason?: string }>;
}
export interface ConnectionView {
  name: string;
  type: 'postgres' | 'sqlite' | 'http';
  description: string | null;
  explore: boolean;
  target: string;
  missingEnv: string[];
  tools: number;
}
export interface ParamSpec {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
  min?: number;
  max?: number;
}
export interface DeclaredTool {
  name: string;
  connection: string;
  description: string;
  params?: Record<string, ParamSpec>;
  sql?: string;
  request?: { method?: string; path: string; query?: Record<string, string>; body?: unknown; pick?: string };
  readOnly?: boolean;
}
export interface ToolView {
  name: string;
  description: string;
  group: string | null;
  readOnly: boolean;
  declared: boolean;
  inputSchema: { properties?: Record<string, { type?: string; description?: string; enum?: string[]; default?: unknown }>; required?: string[] };
}
export interface State {
  version: string;
  dir: string;
  editable: boolean;
  canRestart: boolean;
  store: { kind: string; location: string };
  index: { chunks: number; withVectors: number; documents: number; meaning: boolean; problem: string | null } | null;
  plugins: PluginStatus[];
  folders: Array<{ path: string; name: string | null; documents: number | null }>;
  services: {
    drive: { set: boolean; trusted: string[] };
    slack: { set: boolean };
    github: { set: boolean };
    railway: { set: boolean };
    embeddings: { set: boolean; model: string | null; baseUrl: string | null };
  };
  connections: ConnectionView[];
  declaredTools: DeclaredTool[];
  tools: ToolView[];
}
export interface Changed {
  ok: true;
  restarting: boolean;
  restartNeeded: boolean;
  found?: string;
  note?: string;
  [k: string]: unknown;
}
