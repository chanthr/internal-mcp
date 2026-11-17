/**
 * Live checks the setup wizard runs on what the user enters, before anything is written.
 *
 * Each check calls the real service once with the value just typed and returns what it found (who the token
 * belongs to, what it can see) or throws a message that says what to fix. They take their inputs as arguments
 * instead of reading process.env, because the server's own modules read env once at import and would not see a
 * value entered a moment ago. Base URLs can be overridden so tests run against local fakes.
 */
import { readFileSync } from 'node:fs';
import { createDriveClient, credentialsFromJson } from '../plugins/drive/client.js';

const TIMEOUT_MS = 15_000;

async function getJson(url: string, init: RequestInit, what: string): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // "fetch failed" alone says nothing: the reason is in the cause (ECONNREFUSED, ENOTFOUND, a TLS error, a timeout).
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = (e as { name?: string }).name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000}s` : cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`${what}: could not reach ${new URL(url).host} (${why})`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

export interface DriveCheck {
  /** "service_account" or "refresh_token". */
  kind: string;
  /** The address to share folders and documents with (service accounts only). */
  email: string | null;
  /** Names of the top items shared with the account, folders first. At most `limit`. */
  shared: Array<{ id: string; name: string; folder: boolean; owners: string[]; driveId: string | null }>;
  /** True when more items are shared than were listed. */
  more: boolean;
}

/** Drive: read the credentials file, get a token, and list what is shared with the account. */
export async function checkDrive(credentialsPath: string, opts: { apiBase?: string; limit?: number } = {}): Promise<DriveCheck> {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath, 'utf8');
  } catch (e) {
    throw new Error(`Drive: cannot read ${credentialsPath} (${e instanceof Error ? e.message : String(e)})`);
  }
  return checkDriveCredentials(raw, credentialsPath, opts);
}

/** The same check for credentials that are already in memory (an inline GOOGLE_SERVICE_ACCOUNT_KEY). */
export async function checkDriveCredentials(raw: string, source: string, opts: { apiBase?: string; limit?: number } = {}): Promise<DriveCheck> {
  const creds = credentialsFromJson(raw, source);
  const drive = opts.apiBase ? createDriveClient(creds, opts.apiBase) : createDriveClient(creds);
  const limit = opts.limit ?? 20;
  const res = await drive.files.list({
    q: 'sharedWithMe = true and trashed = false',
    fields: 'nextPageToken, files(id, name, mimeType, owners(emailAddress), driveId)',
    pageSize: limit,
    orderBy: 'folder, name',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  return {
    kind: creds.kind,
    email: creds.kind === 'service_account' ? creds.clientEmail : null,
    shared: files.map((f) => ({
      id: f.id ?? '',
      name: f.name ?? '(no name)',
      folder: f.mimeType === 'application/vnd.google-apps.folder',
      owners: (f.owners ?? []).map((o) => o.emailAddress ?? '').filter(Boolean),
      driveId: f.driveId ?? null,
    })),
    more: !!res.data.nextPageToken,
  };
}

export interface EmbeddingCheck {
  /** Vector size the model returned. Becomes EMBEDDING_DIM. */
  dim: number;
  model: string;
}

/** Embeddings: embed one word and read the vector size from the answer, so the user never has to look it up. */
export async function checkEmbedding(opts: { baseUrl?: string; model?: string; apiKey?: string }): Promise<EmbeddingCheck> {
  const base = (opts.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model?.trim() || 'text-embedding-3-small';
  const { status, json, text } = await getJson(
    `${base}/embeddings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, input: ['setup check'] }),
    },
    'Embeddings',
  );
  if (status === 401 || status === 403) throw new Error(`Embeddings: the key was rejected (${status}). Check the key and that it may use "${model}".`);
  if (status === 404) throw new Error(`Embeddings: ${base}/embeddings answered 404. Check the base URL (it usually ends in /v1) and the model name "${model}".`);
  const vec = json?.data?.[0]?.embedding;
  if (status !== 200 || !Array.isArray(vec) || vec.length === 0) {
    throw new Error(`Embeddings: unexpected answer ${status} from ${base} (${(json?.error?.message ?? text).toString().slice(0, 160)})`);
  }
  return { dim: vec.length, model };
}

/** Slack: who the token belongs to. `kind` tells a bot token from a user token. */
export async function checkSlack(token: string, opts: { apiBase?: string } = {}): Promise<{ team: string; user: string; kind: 'bot' | 'user' }> {
  const base = (opts.apiBase ?? 'https://slack.com/api').replace(/\/+$/, '');
  const { json } = await getJson(`${base}/auth.test`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, 'Slack');
  if (!json?.ok) {
    const why = json?.error === 'invalid_auth' || json?.error === 'not_authed' ? 'the token was rejected' : (json?.error ?? 'no answer');
    throw new Error(`Slack: ${why}. A bot token starts with xoxb-, a user token with xoxp-.`);
  }
  return { team: String(json.team ?? ''), user: String(json.user ?? ''), kind: json.bot_id ? 'bot' : 'user' };
}

/** GitHub: the account behind the token. */
export async function checkGithub(token: string, opts: { apiBase?: string } = {}): Promise<{ login: string }> {
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const { status, json } = await getJson(
    `${base}/user`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'knowledge-mcp-setup' } },
    'GitHub',
  );
  if (status === 401) throw new Error('GitHub: the token was rejected (expired or revoked).');
  if (status !== 200 || typeof json?.login !== 'string') throw new Error(`GitHub: unexpected answer ${status}.`);
  return { login: json.login };
}

/** Railway: the token works for the API. An account token names its user; a team or project token has no "me". */
export async function checkRailway(token: string, opts: { apiBase?: string } = {}): Promise<{ who: string }> {
  const url = opts.apiBase ?? 'https://backboard.railway.app/graphql/v2';
  const call = (query: string) =>
    getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query }) }, 'Railway');
  const me = await call('{ me { name email } }');
  if (me.json?.data?.me) return { who: String(me.json.data.me.email ?? me.json.data.me.name ?? 'account token') };
  const projects = await call('{ projects { edges { node { name } } } }');
  const edges = projects.json?.data?.projects?.edges;
  if (Array.isArray(edges)) return { who: `team or project token (${edges.length} projects visible)` };
  const why = projects.json?.errors?.[0]?.message ?? me.json?.errors?.[0]?.message ?? `answer ${projects.status}`;
  throw new Error(`Railway: the token was rejected (${String(why).slice(0, 120)}).`);
}

/** A Postgres connection string, checked by connecting: which server answered and how many tables this user can read. */
export async function checkPostgresUrl(name: string, url: string): Promise<{ version: string; tables: number }> {
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error('a Postgres connection string starts with postgres:// (postgres://user:password@host:5432/database)');
  const { postgresAdapter } = await import('../connections/postgres.js');
  // The adapter reads its URL from an env var. The value is not saved yet, so it gets a name of its own for the check.
  const key = `KMCP_SETUP_CHECK_${Date.now()}`;
  process.env[key] = url;
  const adapter = postgresAdapter({ name, urlEnv: key, pool: 1 });
  try {
    return { version: await adapter.ping(), tables: (await adapter.tables()).length };
  } finally {
    await adapter.close();
    delete process.env[key];
  }
}

/** A SQLite file, checked by opening it read-only. */
export async function checkSqliteFile(name: string, path: string): Promise<{ version: string; tables: number }> {
  const { sqliteAdapter } = await import('../connections/sqlite.js');
  const adapter = sqliteAdapter({ name, path });
  return { version: await adapter.ping(), tables: (await adapter.tables()).length };
}
