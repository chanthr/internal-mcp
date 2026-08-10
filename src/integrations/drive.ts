/**
 * Google Drive API wrapper.
 *
 * 인증 옵션 (우선순위 순):
 *   1. Service Account JSON (권장 — production-grade)
 *      - GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON, Railway 친화)
 *      - GOOGLE_APPLICATION_CREDENTIALS (JSON 파일 path)
 *
 *   2. OAuth Refresh Token (fallback, single-user)
 *      - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
 *      - Legacy DRIVE_* fallback
 *
 * Service Account 사용 시:
 *   - Drive 폴더에 service account email (xxx@<project>.iam.gserviceaccount.com) viewer 공유 필수
 *   - refresh_token 만료·rotation 없음
 *   - server-to-server auth (production standard)
 */
import { google, drive_v3 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

let _client: drive_v3.Drive | null = null;

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Drive API 전역 timeout — googleapis 는 명시 timeout 이 없으면 무한에 가깝게 hang 할 수 있어
// (search/read/list·classifyAndPath 부모 walk가 매달리면 stateless transport 에서 도구 호출
// 전체가 멈춤). google.options 로 전역 15s 부여. internal-mcp 는 google API 를 drive 만 쓴다.
const DRIVE_TIMEOUT_MS = Number(process.env.DRIVE_TIMEOUT_MS ?? 15_000);
google.options({ timeout: DRIVE_TIMEOUT_MS });

export function getDriveClient(): drive_v3.Drive {
  if (_client) return _client;

  // ── Option 1: Service Account (권장) ────────────────────
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountJson) {
    // Inline JSON (Railway env)
    let parsed;
    try {
      parsed = JSON.parse(serviceAccountJson);
    } catch (e) {
      throw new Error(
        '[drive] GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ' +
          (e instanceof Error ? e.message : String(e))
      );
    }
    const auth = new GoogleAuth({
      credentials: parsed,
      scopes: [DRIVE_READONLY_SCOPE],
    });
    _client = google.drive({ version: 'v3', auth });
    return _client;
  }

  if (credentialsPath) {
    // GoogleAuth 가 자동 GOOGLE_APPLICATION_CREDENTIALS env 인식
    const auth = new GoogleAuth({ scopes: [DRIVE_READONLY_SCOPE] });
    _client = google.drive({ version: 'v3', auth });
    return _client;
  }

  // ── Option 2: OAuth Refresh Token (fallback) ────────────
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.DRIVE_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.DRIVE_CLIENT_SECRET;
  const refreshToken =
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth = new google.auth.OAuth2(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    _client = google.drive({ version: 'v3', auth: oauth });
    return _client;
  }

  throw new Error(
    '[drive] Drive credentials missing. Use one of:\n' +
      '  (1) GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) ← 권장\n' +
      '  (2) GOOGLE_APPLICATION_CREDENTIALS (JSON file path) ← 권장\n' +
      '  (3) GOOGLE_OAUTH_CLIENT_ID + _SECRET + _REFRESH_TOKEN ← fallback'
  );
}

/** Google Drive query language 의 single-quote escape. */
export function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
