# OAuth 2.1 setup (optional)

Knowledge MCP can act as its own OAuth 2.1 Authorization Server, bridging login to **Google
Workspace** and issuing its own short-lived tokens. This is what lets Claude's custom **web
connectors** sign users in. If you don't need that, skip this file — the server works with Bearer
API keys alone (`mcp_keys` + `validate_mcp_key`).

## What it does

- `/authorize` redirects the user to Google (OIDC), restricted to your allowed domain/emails.
- On callback the server verifies the Google `id_token` (`hd` + email allowlist), then issues its
  own **HS256** access (1h) and refresh (30d) tokens. Access-token `aud` = your canonical `/mcp`.
- Refresh tokens rotate with reuse-detection (revoked via `mcp_refresh_tokens`).
- Dynamic Client Registration (DCR) is persisted in `mcp_oauth_clients` so connectors survive redeploys.

## Steps

1. **Create a Google OAuth client** (Web application) in Google Cloud Console.
   - Authorized redirect URI: `https://<your-host>/oauth/google/callback`
2. **Set env vars** (see `.env.example`):
   ```
   MCP_OAUTH_ISSUER=https://<your-host>
   MCP_RESOURCE=https://<your-host>/mcp
   OAUTH_GOOGLE_CLIENT_ID=<client_id>.apps.googleusercontent.com
   OAUTH_GOOGLE_CLIENT_SECRET=<client_secret>
   OAUTH_JWT_SECRET=<random string, >= 32 chars>
   ```
3. **Restrict who can log in** — either:
   - `OAUTH_ALLOWED_HD=example.com` (a Google Workspace domain), and/or
   - `OAUTH_ALLOWED_EMAILS=a@example.com,b@example.com`
   - (or set these in `mcp.config.json` under `oauth.allowedDomains` / `oauth.allowedEmails`)
4. **Run the SQL** in `sql/setup.sql` (creates `mcp_oauth_clients` and `mcp_refresh_tokens`).
5. **Deploy.** On boot you'll see `OAuth enabled · issuer=… · resource=…` in the logs. If any
   required value is missing, OAuth is silently disabled and the server falls back to Bearer keys.

## Roles

A user's effective role comes from `app_users` (looked up by the Google email). Registered admins
get `admin`; everyone else is `engineer`, and unknown emails are `viewer`. Add rows to `app_users`
to grant roles and optional per-user resource scopes.
