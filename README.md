# Knowledge MCP

A self-hostable [MCP](https://modelcontextprotocol.io) server that exposes **your** Google Drive,
Slack, GitHub and Railway to any MCP client (Claude Desktop, Claude web connectors, IDEs, …) —
with semantic search, per-user permissions, and optional OAuth. You bring the credentials and a
small config; everything about *what to look at* is yours.

## Tools

| Tool | What it does | Needs |
|------|--------------|-------|
| `search_drive` | Keyword/filename search over indexed Drive assets | Drive creds |
| `read_drive_file` | Read full file contents by File ID (batchable) | Drive creds |
| `list_drive_folder` | Exhaustive listing of a folder | Drive creds |
| `semantic_search_drive` | Vector (RAG) search over Drive content | Qdrant + OpenAI |
| `slack_search` / `slack_read_channel` / `slack_list_channels` / `slack_find_files` / `slack_get_file` | Read Slack (read-only) | Slack token |
| `repo_tree` (+ `github_*` upstream) | Explore private repo structure / proxy GitHub MCP | GitHub token |
| `railway_services` / `railway_deployments` / `railway_logs` | Inspect Railway infra | Railway token |
| `ping` | Health check | — |

Every tool group is **gated by its credentials**: a group you don't configure simply isn't offered
to the client, so the model never tries a tool that can't work.

## How configuration works

Two layers, kept separate on purpose:

- **Secrets → environment variables** (`.env` locally, host env vars in prod). See `.env.example`.
- **What to look at → `mcp.config.json`** (Drive folder IDs, Qdrant collection, Supabase schema,
  domains, branding). See `mcp.config.example.json`.

Config resolution order: `MCP_CONFIG_JSON` (inline env) → `MCP_CONFIG_PATH` (file) →
`./mcp.config.json` → built-in neutral defaults.

| Config key | Meaning |
|------------|---------|
| `orgId` | Organization identifier carried in the auth context |
| `branding.name` / `branding.instructions` | Server name + the routing guide the client sees on connect |
| `drive.roots[]` | `{ id, name, source }` folders to index. `source`: `dev` (structured docs) or `biz` (general documents) |
| `drive.excludeFolders[]` | Folder names to exclude from the index (your PII/HR/contracts) |
| `qdrant.collection` | Vector collection name (env `QDRANT_COLLECTION` overrides) |
| `data.schema` | Supabase schema holding the server's tables (default `public`) |
| `selfDomains[]` | Your own domains |
| `oauth.allowedDomains[]` / `oauth.allowedEmails[]` | Login allowlist (env overrides available) |

## Quick start

```bash
# 1) Install
npm install

# 2) Configure
cp .env.example .env                       # fill in credentials
cp mcp.config.example.json mcp.config.json # set your Drive folder IDs, domains, etc.

# 3) Prepare Supabase
#    Run sql/setup.sql in your Supabase project, then provision an admin key:
#    insert into public.mcp_keys (key_hash, org_id, role, email)
#    values (encode(digest('YOUR_RAW_KEY','sha256'),'hex'), 'acme', 'admin', 'you@acme.com');

# 4) Index your Drive (for semantic_search_drive)
npm run reindex

# 5) Run
npm run dev            # local (stdio or http per MCP_TRANSPORT)
# or build + start
npm run build && npm start
```

Point your MCP client at `https://<your-host>/mcp` with `Authorization: Bearer <your key>`.

## Deploy

The repo ships a `Dockerfile` and `railway.toml`. Any container host works (Railway, Fly, a VPS).
The host injects `PORT`; the server listens on it. Set your env vars (and either `MCP_CONFIG_JSON`
or commit-free `mcp.config.json`) in the host, then deploy.

> ⚠️ In-memory sessions assume a **single replica**. For multiple replicas you'd need sticky
> routing and a shared session store.

## OAuth (optional)

Set the `MCP_OAUTH_*` / `OAUTH_*` env vars to turn on a built-in OAuth 2.1 Authorization Server that
bridges login to Google Workspace and issues its own tokens — this is what lets Claude's custom web
connectors sign users in. Without it, the server uses Bearer API keys only. See `OAUTH_SETUP.md`.

## Security notes

- Never commit `google-service-account.json` or `.env` (both are gitignored).
- API keys are stored **hashed** (`validate_mcp_key`), support revoke/expiry, and are rate-limited.
- Per-user roles and resource scopes come from `app_users`; unregistered users are `viewer`.
- The server is **fail-open** for reads and never mutates your source systems (Slack/GitHub/Railway
  access is read-only; Drive is read + index only).

## License

[MIT](LICENSE) © chanthr
