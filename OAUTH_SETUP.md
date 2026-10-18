# OAuth 2.1 setup (optional)

Knowledge MCP can act as its own OAuth 2.1 Authorization Server. It bridges sign-in to **Google** and
issues its own short-lived tokens. This is what lets Claude's custom **web connectors** sign users in.
If you don't need that, skip this file. The server works with Bearer API keys alone
(`knowledge-mcp keys create`).

## What it does

1. A client registers itself through Dynamic Client Registration (DCR). Registrations are kept in the
   store (SQLite file or Supabase `mcp_oauth_clients`), so connectors survive redeploys as long as the
   store does (keep `/data` on a volume).
2. `/authorize` shows a **consent page** first. It names the app and the address the token will be sent
   to. Nothing happens until the user presses "Continue with Google". The button is bound to a cookie,
   so another site cannot press it on the user's behalf, and the page cannot be framed.
3. The user signs in with Google (OIDC). The server checks the `id_token` and the allowlist (below).
4. The server issues its own **HS256** access token (1 hour) and refresh token (30 days). The access
   token's `aud` is your canonical `/mcp` URL.
5. Refresh tokens rotate on every use and stay bound to the client that received them. Reusing an old
   refresh token revokes every refresh token of that account.
6. The allowlist is checked again on every request and every refresh. It is read at startup, so after you
   remove a person, restart the server: from then on their tokens stop working, even unexpired ones.

## Steps

1. **Create a Google OAuth client** (type "Web application") in Google Cloud Console.
   - Authorized redirect URI: `https://<your-host>/oauth/google/callback`
2. **Set env vars** (see `.env.example`):
   ```
   MCP_OAUTH_ISSUER=https://<your-host>
   MCP_RESOURCE=https://<your-host>/mcp
   OAUTH_GOOGLE_CLIENT_ID=<client_id>.apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=<client_secret>
   OAUTH_JWT_SECRET=<random string, >= 32 chars>
   ```
   `MCP_OAUTH_ISSUER` is the origin only, without a path.
3. **Set the allowlist.** This is required. With an empty allowlist OAuth stays off, because otherwise
   any Google account could sign in.
   - `OAUTH_ALLOWED_HD=example.com,example.org` lets in accounts managed by those Google Workspace
     domains. The account's `hd` claim must match, so a personal Google account that happens to use a
     company address is refused.
   - `OAUTH_ALLOWED_EMAILS=a@example.com,b@partner.com` lets in those exact addresses, of any account
     type.
   - A user passes if either list matches. You can also set both lists in `mcp.config.json` under
     `oauth.allowedDomains` and `oauth.allowedEmails`. Env values take precedence.
4. **Supabase store only:** run [`sql/supabase.sql`](packages/knowledge-mcp/sql/supabase.sql). It creates
   `mcp_oauth_clients` and `mcp_refresh_tokens` and locks them to the service-role key. The default SQLite
   store needs nothing.
5. **Deploy.** On boot you will see `OAuth enabled · issuer=… · resource=…` in the logs. If a required
   value is missing, the log says `OAuth off — missing: …` with the names of the missing values, and
   the server falls back to Bearer keys.

## Roles

A user's role comes from their users entry, looked up by their Google email.

| Users entry | Role | What they can use |
| --- | --- | --- |
| `--role admin` | admin | Every tool |
| `--role member` | member | Every plugin, or only the plugins in `--tools`. Drive folders (`--drive-folders`) and Slack channels (`--slack-channels`) can be limited too. Empty means no limit |
| No entry | viewer | Only `ping`, unless `access.viewerTools` in `mcp.config.json` opens plugins |

Signing in proves who someone is. It does not grant access to data. Register each person who should use
the tools:

```bash
knowledge-mcp users add lee@example.com --role member
```
