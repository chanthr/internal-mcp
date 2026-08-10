/**
 * Google OAuth Refresh Token 발급 자동화.
 *
 * 사용법:
 *   1. .env 에 GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET 채워둠
 *   2. (OAuth Client type 이 Web 이면) Cloud Console → Credentials →
 *      OAuth Client → Authorized redirect URIs 에 추가:
 *      http://localhost:3500/callback
 *   3. npm run get-token
 *   4. browser opens -> sign in with your Google account + allow
 *   5. callback 받으면 콘솔에 refresh token 출력
 *   6. .env 에 GOOGLE_OAUTH_REFRESH_TOKEN= 라인 추가
 */
import { google } from 'googleapis';
import http from 'http';
import { config as loadEnv } from 'dotenv';
import { URL } from 'url';
import { exec } from 'child_process';

loadEnv();

const PORT = 3500;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('❌ GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET 가 .env 에 없습니다.');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // refresh_token 강제 발급
  scope: [SCOPE],
});

console.log('\n========================================');
console.log('  OAuth Refresh Token 발급');
console.log('========================================\n');
console.log('1. Local callback server: http://localhost:' + PORT);
console.log('2. 브라우저 자동 열림 (또는 아래 URL 수동 접속):');
console.log('\n' + authUrl + '\n');
console.log('3. Sign in with your Google account and allow access');
console.log('4. 자동 redirect 후 콘솔에 refresh token 출력\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth error: ${error}`);
    console.error('\n❌ OAuth error:', error);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No code received');
    return;
  }

  try {
    const { tokens } = await oauth.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      console.error('\n❌ refresh_token 미발급. 이미 권한 부여한 경우 일 수 있음.');
      console.error('   해결: https://myaccount.google.com/connections 에서');
      console.error('         client 제거 후 다시 시도.\n');
      res.writeHead(400);
      res.end('No refresh_token in response');
      process.exit(1);
    }

    console.log('\n========================================');
    console.log('  ✅ 발급 성공');
    console.log('========================================\n');
    console.log('REFRESH TOKEN:');
    console.log(refreshToken);
    console.log('\n.env 에 다음 라인 추가:');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`);
    console.log('또는 아래 명령으로 자동 추가:');
    console.log(`echo "GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}" >> .env\n`);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;">
      <h2>✅ Refresh Token 발급 완료</h2>
      <p>터미널에서 token 을 확인하고 <code>.env</code> 에 추가하세요.</p>
      <p>이 창은 닫으셔도 됩니다.</p>
    </body></html>`);

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('\n❌ Token exchange failed:', msg);
    res.writeHead(500);
    res.end(`Error: ${msg}`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`✓ Server listening on :${PORT}\n`);
  // macOS 의 open 명령으로 브라우저 자동 열기
  exec(`open "${authUrl}"`, (err) => {
    if (err) {
      console.log('(브라우저 자동 열기 실패. 위 URL 을 수동 복사하세요)');
    }
  });
});
