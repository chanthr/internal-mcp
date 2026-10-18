/**
 * Google Drive API (v3, read-only) over plain HTTPS.
 *
 * 인증 옵션 (우선순위 순):
 *   1. Service Account JSON (권장 — production-grade)
 *      - GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON, Railway 친화)
 *      - GOOGLE_APPLICATION_CREDENTIALS (JSON 파일 path. service_account 또는 authorized_user)
 *
 *   2. OAuth Refresh Token (fallback, single-user)
 *      - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
 *      - Legacy DRIVE_* fallback
 *
 * Service Account 사용 시:
 *   - Drive 폴더에 service account email (xxx@<project>.iam.gserviceaccount.com) viewer 공유 필수
 *   - refresh_token 만료·rotation 없음
 *
 * googleapis 대신 직접 부르는 이유: googleapis(google-auth-library → gaxios → node-fetch → fetch-blob)는
 * 최신판도 폐기된 패키지(node-domexception, 옛 판은 uuid)를 끌어와 설치마다 경고를 남겼고, 불러오는 데만
 * CPU 1초가 넘게 들었다. 이 서버가 쓰는 Drive 엔드포인트는 5개뿐이다. 호출 모양(drive.files.list 등,
 * { data } 반환)은 googleapis 와 같게 둬서 도구 코드는 바꾸지 않았다.
 */
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Drive API 전역 timeout — 명시 timeout 이 없으면 매달린 호출 하나가 도구 호출 전체를 멈춘다.
const DRIVE_TIMEOUT_MS = Number(process.env.DRIVE_TIMEOUT_MS ?? 15_000);
const RETRIES = 3; // 429·5xx·네트워크 오류. GET 만 쓰므로 다시 보내도 안전하다

// ── 응답 타입 (이 서버가 읽는 필드만) ──
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

// ── 인증: 액세스 토큰을 만들고 만료 1분 전까지 다시 쓴다 ──
type Credentials =
  | { kind: 'service_account'; clientEmail: string; privateKey: string; tokenUri: string }
  | { kind: 'refresh_token'; clientId: string; clientSecret: string; refreshToken: string; tokenUri: string };

function credentialsFromJson(raw: string, source: string): Credentials {
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
    const path = env.GOOGLE_APPLICATION_CREDENTIALS;
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
      '  (1) GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) ← 권장\n' +
      '  (2) GOOGLE_APPLICATION_CREDENTIALS (JSON file path) ← 권장\n' +
      '  (3) GOOGLE_OAUTH_CLIENT_ID + _SECRET + _REFRESH_TOKEN ← fallback',
  );
}

async function requestToken(creds: Credentials): Promise<{ token: string; expiresAt: number }> {
  const form = new URLSearchParams();
  if (creds.kind === 'service_account') {
    // OAuth 2.0 JWT bearer grant (RFC 7523): 서비스 계정 키로 서명한 assertion 을 토큰으로 바꾼다.
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
    // Google 은 오류 본문에 토큰이나 키를 돌려주지 않는다. 오류 코드와 설명만 남긴다.
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
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${await accessToken()}`, Accept: responseType === 'json' ? 'application/json' : '*/*' },
          signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof DriveApiError) throw e; // token request failed
        if (attempt + 1 < RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        const reason = e instanceof Error && e.name === 'TimeoutError' ? `timeout ${DRIVE_TIMEOUT_MS}ms` : String(e);
        throw new DriveApiError(`[drive] GET ${path} failed: ${reason}`, 0);
      }
      if (res.status === 401 && attempt === 0) {
        cached = null; // revoked or expired early: get a new token once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt + 1 < RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text.slice(0, 300);
        try {
          msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          /* not JSON */
        }
        throw new DriveApiError(`[drive] ${res.status} ${path}: ${msg}`, res.status);
      }
      if (responseType === 'arraybuffer') return { data: await res.arrayBuffer() };
      if (responseType === 'text') return { data: await res.text() };
      return { data: await res.json() };
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

/** Google Drive query language 의 single-quote escape. */
export function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
