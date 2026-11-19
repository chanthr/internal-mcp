/**
 * Talks to the console API of the server this page came from.
 *
 * The access token arrives once in the address (…/console/#token=…, the part a browser keeps to itself), is kept
 * in this browser's storage for this address only, and is taken out of the address bar. Every call sends it as a
 * header.
 */

/** Where this browser keeps the token, for this address (host and port). */
export const TOKEN_KEY = 'knowledge-mcp-console-token';
const KEY = TOKEN_KEY;

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
    const res = await fetch('./api/state', { headers: { Authorization: `Bearer ${m[1]}` } });
    accepted = res.ok && ours(res);
  } catch {
    /* the server is not answering: keep what we have */
  }
  if (accepted) setToken(m[1]);
  return accepted;
}

/** Fired on the window when the server refuses the token, so the page asks for one instead of showing errors. */
export const REFUSED = 'knowledge-mcp-console-refused';

/**
 * Did this server's console answer? Every answer of it carries this header. One without it came from something
 * else on the address: another program that listens on the same port and answers while the server restarts, or a
 * proxy. Such an answer is treated as no answer. Above all its "not allowed" is not taken for "the token is not
 * accepted": that sent people to the page that asks for the token, with a token that was fine.
 */
const ours = (res: Response): boolean => res.headers.has('x-knowledge-mcp-console');
/** Thrown for an answer that is not this server's. `status` 0, like no answer at all. */
const notOurs = () => new ApiError('Something else answered on this address. The server may be starting again.', 0);

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
  if (!ours(res)) throw notOurs();
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

/** Send one file to the uploads folder. `path` is its place inside it ("notes/plan.md"). */
export async function uploadFile(path: string, file: Blob): Promise<void> {
  const res = await fetch(`./api/uploads?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token() ?? ''}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!ours(res)) throw notOurs();
  if (res.ok) return;
  if (res.status === 401) window.dispatchEvent(new Event(REFUSED));
  const text = await res.text();
  let error = text || `The server answered ${res.status}.`;
  try {
    error = (JSON.parse(text) as { error?: string }).error ?? error;
  } catch {
    /* not JSON */
  }
  throw new ApiError(error, res.status);
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
/** Some files of a folder, by name: how many there are, and the first few. */
export interface SomeFiles {
  count: number;
  names: string[];
}
export interface FolderView {
  path: string;
  name: string | null;
  /** Documents in the index. null: the folder is not there any more. */
  documents: number | null;
  /** Set while the server reads the folder: files looked at, of the files in it. The count above is moving. */
  reading: { done: number; total: number } | null;
  /** Files with nothing to read in them (scanned pages, empty files), and files that would not open. */
  noText: SomeFiles;
  failed: SomeFiles;
}
export interface State {
  version: string;
  dir: string;
  editable: boolean;
  canRestart: boolean;
  store: { kind: string; location: string };
  index: {
    chunks: number;
    withVectors: number;
    documents: number;
    meaning: boolean;
    /** Set when the vectors in the index were made by another model than the one configured. */
    problem: string | null;
    vectorsFrom: string | null;
    /** New vectors being made for the whole index, started from this page. */
    job: { running: boolean; done: number; total: number; error: string | null } | null;
  } | null;
  plugins: PluginStatus[];
  folders: FolderView[];
  services: {
    /** `via`: a service account key, or a Google sign-in (then `account` is who, and `reads` the folders). */
    drive: { set: boolean; trusted: string[]; via: 'key' | 'login' | null; account: string | null; reads: string[] };
    slack: { set: boolean };
    github: { set: boolean };
    /** `logs`: the sign-in asked for the access that reads logs (member). null with a token. */
    railway: { set: boolean; via: 'token' | 'login' | null; who: string | null; logs: boolean | null };
    embeddings: { set: boolean; model: string | null; dim: number | null; baseUrl: string | null; keySet: boolean };
    /** A language model for the server's own work (the Agent page). The key is never sent back. */
    llm: { set: boolean; provider: 'anthropic' | 'openai' | null; model: string | null; baseUrl: string | null; keySet: boolean };
  };
  connections: ConnectionView[];
  declaredTools: DeclaredTool[];
  tools: ToolView[];
  /** Other services' MCP servers in the list. */
  upstreams: UpstreamView[];
  /** A sign-in that came back from the other site and waits to be saved. */
  login: { service: 'railway' | 'google' | 'mcp' } | null;
}
export interface UpstreamView {
  name: string;
  url: string;
  /** What its tool names start with. */
  prefix: string;
  /** "read": only the tools that read. "all": everything. "list": the names written in the config file. */
  expose: 'read' | 'all' | 'list';
  via: 'login' | 'token' | 'open';
  /** For a sign-in: is it still there? */
  signedIn: boolean | null;
  /** False: saved, and waiting for the server to start again. */
  running: boolean;
  connected: boolean;
  tools: number;
  /** Tools the read-only gateway leaves out. */
  hidden: number;
  error: string | null;
}

/**
 * Leave the console for another site's sign-in page. The server makes the address and the site sends the browser
 * back here. Does not return: the page is on its way out.
 */
export async function signIn(path: string, body: unknown = {}): Promise<never> {
  const { url } = await call<{ url: string }>('POST', path, body);
  location.assign(url);
  return new Promise<never>(() => undefined);
}
export interface Changed {
  ok: true;
  restarting: boolean;
  restartNeeded: boolean;
  found?: string;
  note?: string;
  [k: string]: unknown;
}
