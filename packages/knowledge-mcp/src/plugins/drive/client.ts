/**
 * Google Drive API (v3, read-only) over plain HTTPS.
 *
 * Auth options (in priority order):
 *   1. Service Account JSON (recommended, production-grade)
 *      - GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON, convenient on Railway)
 *      - GOOGLE_APPLICATION_CREDENTIALS (path to a JSON file: service_account or authorized_user)
 *
 *   2. OAuth Refresh Token (fallback, single-user)
 *      - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
 *      - Legacy DRIVE_* fallback
 *
 * With a Service Account:
 *   - the Drive folder must be shared with the service account email (xxx@<project>.iam.gserviceaccount.com) as viewer
 *   - no refresh_token expiry or rotation
 *
 * Why this calls the API directly instead of using googleapis: googleapis (google-auth-library → gaxios → node-fetch →
 * fetch-blob) pulls in deprecated packages even in its latest version (node-domexception, and uuid in older versions),
 * which left warnings on every install, and loading it alone took more than 1 second of CPU. This server uses only 5 Drive
 * endpoints. The call shape (drive.files.list etc., returning { data }) matches googleapis, so the tool code did not change.
 */
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';
import { settingsFile } from '../../core/paths.js';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Global timeout for the Drive API. Without an explicit timeout, one hung call stalls the entire tool call.
const DRIVE_TIMEOUT_MS = Number(process.env.DRIVE_TIMEOUT_MS ?? 15_000);
const DRIVE_DOWNLOAD_TIMEOUT_MS = Number(process.env.DRIVE_DOWNLOAD_TIMEOUT_MS ?? 120_000);
const RETRIES = 3; // 429, 403 rate limits, 5xx, network errors. Only GET is used, so resending is safe

// ── Response types (only the fields this server reads) ──
export interface DriveFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  parents?: string[] | null;
  modifiedTime?: string | null;
  size?: string | null;
  webViewLink?: string | null;
  trashed?: boolean | null;
  owners?: Array<{ emailAddress?: string | null; displayName?: string | null }> | null;
  /** Set for items that live in a shared drive (those have no owners). */
  driveId?: string | null;
  [field: string]: unknown;
}
export interface DriveChange {
  removed?: boolean | null;
  fileId?: string | null;
  file?: DriveFile | null;
}
export interface DriveChangeList {
  nextPageToken?: string | null;
  newStartPageToken?: string | null;
  changes?: DriveChange[];
}
export interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string | null;
}

type Params = Record<string, string | number | boolean | undefined>;
type ResponseType = 'json' | 'text' | 'arraybuffer';

export interface DriveClient {
  files: {
    list(params: Params): Promise<{ data: DriveFileList }>;
    /** Metadata, or the file body with `alt: 'media'` and a response type. */
    get(params: Params & { fileId: string }, opts?: { responseType?: ResponseType }): Promise<{ data: any }>;
    export(params: Params & { fileId: string; mimeType: string }, opts?: { responseType?: ResponseType }): Promise<{ data: any }>;
  };
  changes: {
    getStartPageToken(params?: Params): Promise<{ data: { startPageToken?: string | null } }>;
    list(params: Params & { pageToken: string }): Promise<{ data: DriveChangeList }>;
  };
}

export class DriveApiError extends Error {
  constructor(
    message: string,
    /** HTTP status (0 = network or timeout). googleapis put the same value in `code`. */
    readonly code: number,
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

// ── Auth: create an access token and reuse it until 1 minute before it expires ──
export type Credentials =
  | { kind: 'service_account'; clientEmail: string; privateKey: string; tokenUri: string }
  | { kind: 'refresh_token'; clientId: string; clientSecret: string; refreshToken: string; tokenUri: string };

export function credentialsFromJson(raw: string, source: string): Credentials {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[drive] ${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (j.type === 'authorized_user') {
    return {
      kind: 'refresh_token',
      clientId: String(j.client_id ?? ''),
      clientSecret: String(j.client_secret ?? ''),
      refreshToken: String(j.refresh_token ?? ''),
      tokenUri: DEFAULT_TOKEN_URI,
    };
  }
  if (typeof j.client_email !== 'string' || typeof j.private_key !== 'string') {
    throw new Error(`[drive] ${source} must be a service account key (client_email, private_key) or an authorized_user file`);
  }
  return {
    kind: 'service_account',
    clientEmail: j.client_email,
    privateKey: j.private_key,
    tokenUri: typeof j.token_uri === 'string' ? j.token_uri : DEFAULT_TOKEN_URI,
  };
}

/** Which credentials the env provides. Throws with the options when none are set. */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) return credentialsFromJson(env.GOOGLE_SERVICE_ACCOUNT_KEY, 'GOOGLE_SERVICE_ACCOUNT_KEY');
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    // A relative path is in the settings folder, as setup and the console read it (.env.example suggests
    // ./google-service-account.json). Read from the working directory, a repository's own key file would become the
    // Drive account, and its token_uri the address the signed request goes to.
    const path = settingsFile(env.GOOGLE_APPLICATION_CREDENTIALS);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(`[drive] cannot read GOOGLE_APPLICATION_CREDENTIALS (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return credentialsFromJson(raw, 'GOOGLE_APPLICATION_CREDENTIALS');
  }
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || env.DRIVE_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || env.DRIVE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN || env.DRIVE_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    return { kind: 'refresh_token', clientId, clientSecret, refreshToken, tokenUri: DEFAULT_TOKEN_URI };
  }
  throw new Error(
    '[drive] Drive credentials missing. Use one of:\n' +
      '  (1) GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) ← recommended\n' +
      '  (2) GOOGLE_APPLICATION_CREDENTIALS (JSON file path) ← recommended\n' +
      '  (3) GOOGLE_OAUTH_CLIENT_ID + _SECRET + _REFRESH_TOKEN ← fallback',
  );
}

async function requestToken(creds: Credentials): Promise<{ token: string; expiresAt: number }> {
  const form = new URLSearchParams();
  if (creds.kind === 'service_account') {
    // OAuth 2.0 JWT bearer grant (RFC 7523): exchanges an assertion signed with the service account key for a token.
    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(creds.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: DRIVE_READONLY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(creds.clientEmail)
      .setAudience(creds.tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    form.set('assertion', assertion);
  } else {
    form.set('grant_type', 'refresh_token');
    form.set('client_id', creds.clientId);
    form.set('client_secret', creds.clientSecret);
    form.set('refresh_token', creds.refreshToken);
  }
  const res = await fetch(creds.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    // Google does not return tokens or keys in error bodies. Only the error code and description are kept.
    throw new DriveApiError(`[drive] token request failed ${res.status}: ${body.error ?? ''} ${body.error_description ?? ''}`.trim(), res.status);
  }
  return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

/** Builds a client. `apiBase` and credentials are injectable for tests; production uses env and Google URLs. */
export function createDriveClient(creds: Credentials, apiBase = DRIVE_API): DriveClient {
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  const accessToken = (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return Promise.resolve(cached.token);
    pending ??= requestToken(creds)
      .then((t) => {
        cached = t;
        return t.token;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const get = async (path: string, params: Params = {}, responseType: ResponseType = 'json'): Promise<{ data: any }> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const url = `${apiBase}${path}${qs.size ? `?${qs}` : ''}`;
    // Content downloads (media, export) fetch large PDFs or PPTX files, so they wait longer than metadata lookups.
    const timeoutMs = responseType === 'json' ? DRIVE_TIMEOUT_MS : DRIVE_DOWNLOAD_TIMEOUT_MS;
    const backoff = (attempt: number, retryAfter?: number) =>
      new Promise((r) => setTimeout(r, retryAfter && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt));
    for (let attempt = 0; ; attempt++) {
      const retriesLeft = attempt + 1 < RETRIES;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${await accessToken()}`, Accept: responseType === 'json' ? 'application/json' : '*/*' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 && attempt === 0) {
          cached = null; // revoked or expired early: get a new token once
          await res.arrayBuffer().catch(() => undefined);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // Drive also signals rate limits with 403 rateLimitExceeded / userRateLimitExceeded, not just 429.
          const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(text));
          if ((rateLimited || res.status >= 500) && retriesLeft) {
            await backoff(attempt, Number(res.headers.get('retry-after')));
            continue;
          }
          let msg = text.slice(0, 300);
          try {
            msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
          } catch {
            /* not JSON */
          }
          throw new DriveApiError(`[drive] ${res.status} ${path}: ${msg}`, res.status);
        }
        // Reading the body is inside the retry scope too: if a large file is cut off midway on a slow link, it is fetched
        // once more.
        if (responseType === 'arraybuffer') return { data: await res.arrayBuffer() };
        if (responseType === 'text') return { data: await res.text() };
        return { data: await res.json() };
      } catch (e) {
        if (e instanceof DriveApiError) throw e; // HTTP error above, or the token request failed
        if (retriesLeft) {
          await backoff(attempt);
          continue;
        }
        const reason = e instanceof Error && e.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : String(e);
        throw new DriveApiError(`[drive] GET ${path} failed: ${reason}`, 0);
      }
    }
  };

  const fileId = (id: string) => encodeURIComponent(id);
  return {
    files: {
      list: (params) => get('/files', params),
      get: ({ fileId: id, ...params }, opts) => get(`/files/${fileId(id)}`, params, opts?.responseType ?? 'json'),
      export: ({ fileId: id, ...params }, opts) => get(`/files/${fileId(id)}/export`, params, opts?.responseType ?? 'text'),
    },
    changes: {
      getStartPageToken: (params) => get('/changes/startPageToken', params),
      list: (params) => get('/changes', params),
    },
  };
}

let _client: DriveClient | null = null;

/** The process-wide Drive client, built from env on first use. */
export async function getDriveClient(): Promise<DriveClient> {
  _client ??= createDriveClient(resolveCredentials());
  return _client;
}

/** Single-quote escape for the Google Drive query language. */
export function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
