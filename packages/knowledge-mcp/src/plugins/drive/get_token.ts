/**
 * Google OAuth Refresh Token 발급 자동화.
 *
 * 사용법:
 *   1. .env 에 GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET 채워둠
 *   2. (OAuth Client type 이 Web 이면) Cloud Console → Credentials →
 *      OAuth Client → Authorized redirect URIs 에 추가:
 *      http://localhost:3500/callback
 *   3. knowledge-mcp drive get-token
 *   4. browser opens -> sign in with your Google account + allow
 *   5. callback 받으면 콘솔에 refresh token 출력
 *   6. .env 에 GOOGLE_OAUTH_REFRESH_TOKEN= 라인 추가
 */
import http from 'http';
import { URL } from 'url';
import { execFile } from 'child_process';

const PORT = 3500;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * `knowledge-mcp drive get-token` — opens Google sign-in and prints a Drive refresh token.
 * The token is written with process.stdout.write: console output is masked and would hide it.
 */
export async function runGetToken(): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET not found in .env.');
    process.exit(1);
  }

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent', // refresh_token 강제 발급
    }).toString();

  console.log('\n========================================');
  console.log('  Issue an OAuth Refresh Token');
  console.log('========================================\n');
  console.log('1. Local callback server: http://localhost:' + PORT);
  console.log('2. A browser opens automatically (or open the URL below manually):');
  console.log('\n' + authUrl + '\n');
  console.log('3. Sign in with your Google account and allow access');
  console.log('4. After the automatic redirect, the refresh token is printed to the console\n');

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
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
        }),
      });
      const tokens = (await tokenRes.json()) as { refresh_token?: string; error?: string; error_description?: string };
      if (!tokenRes.ok) throw new Error(`${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ''}`.trim());
      const refreshToken = tokens.refresh_token;

      if (!refreshToken) {
        console.error('\n❌ No refresh_token was issued. This can happen if access was already granted.');
        console.error('   Fix: go to https://myaccount.google.com/connections,');
        console.error('        remove the client, then try again.\n');
        res.writeHead(400);
        res.end('No refresh_token in response');
        process.exit(1);
      }

      console.log('\n========================================');
      console.log('  ✅ Token issued');
      console.log('========================================\n');
      console.log('Add this line to .env:\n');
      process.stdout.write(`GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n\n`);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;">
        <h2>✅ Refresh Token issued</h2>
        <p>Copy the token from the terminal and add it to <code>.env</code>.</p>
        <p>You can close this window.</p>
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
    // 브라우저 자동 열기 (macOS open, Linux xdg-open, Windows start)
    const opener = process.platform === 'darwin' ? ['open', [authUrl]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authUrl]] : ['xdg-open', [authUrl]];
    execFile(opener[0] as string, opener[1] as string[], (err) => {
      if (err) {
        console.log('(Could not open the browser automatically. Copy the URL above manually)');
      }
    });
  });
  await new Promise<never>(() => {}); // 콜백이 process.exit 로 끝낸다
}
