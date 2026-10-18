<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <img alt="Knowledge MCP" src=".github/assets/banner-light.svg" width="100%">
  </picture>
</h1>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src=".github/assets/badge-license.svg"></a>
  <a href="#quick-start"><img alt="node: 22+" src=".github/assets/badge-node.svg"></a>
  <a href="#connect-a-client"><img alt="MCP: HTTP + stdio" src=".github/assets/badge-mcp.svg"></a>
  <a href="#access-control"><img alt="auth: Key + OAuth" src=".github/assets/badge-auth.svg"></a>
</p>

<p align="center">
  <b>Connect Claude and other MCP clients to your Google Drive, Slack, GitHub and Railway.</b><br>
  Run one server, sign people in with API keys or Google, and give each person only the data they need.
</p>

<p align="center">
  <b>English</b>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#tools">Tools</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#configuration">Configuration</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#access-control">Access control</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#deploy">Deploy</a>
</p>

## Quick start

You need Docker, a Supabase project and Google Drive credentials. Semantic search also needs Qdrant and an
OpenAI API key.

| Step | What to do |
| :---: | --- |
| **1** | Run [`sql/setup.sql`](sql/setup.sql) in the Supabase SQL editor. Copy `.env.example` to `.env` and `mcp.config.example.json` to `mcp.config.json`, then fill them in. |
| **2** | Start the server with `docker compose up -d`. Build the search index once with `docker compose run --rm reindex`. |
| **3** | Create an API key, then point your client at `http://localhost:8080/mcp`. `curl localhost:8080/health` should answer `{"ok":true}`. |

<details>
<summary>Commands for each step</summary>
<br>

```bash
# 1) Get the files and configure
git clone https://github.com/chanthr/internal-mcp.git && cd internal-mcp
cp .env.example .env                        # Supabase, Drive, OpenAI, Qdrant, Slack... credentials
cp mcp.config.example.json mcp.config.json  # Drive folder IDs, excluded folders, login allowlist
# Run sql/setup.sql in the Supabase SQL editor. Run it again after every upgrade; it is idempotent.

# 2) Start and index
docker compose up -d
docker compose run --rm reindex             # first full Drive index; the server keeps it fresh afterwards

# 3) Check
curl http://localhost:8080/health
```

Create a key in the Supabase SQL editor. Generate the raw key with `openssl rand -hex 32` and give it to
the person once. A key with an email takes its role and scopes from `app_users`.

```sql
insert into public.app_users (email, role) values ('you@acme.com', 'admin')
  on conflict (email) do update set role = excluded.role;
insert into public.mcp_keys (key_hash, org_id, email)
values (encode(sha256(convert_to('PASTE_RAW_KEY', 'UTF8')), 'hex'), 'acme', 'you@acme.com');
```

</details>

<details>
<summary>Run from source instead of Docker</summary>
<br>

Requires Node 22 or later.

```bash
npm install
cp .env.example .env && cp mcp.config.example.json mcp.config.json
npm run reindex          # full Drive index (add -- --dry-run to only count chunks)
npm run dev              # http or stdio, per MCP_TRANSPORT
npm run build && npm start
```

</details>

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/flow-dark.svg">
    <img alt="How it works: Connect, Authorize, Offer tools, Read" src=".github/assets/flow-light.svg" width="100%">
  </picture>
</p>

<details>
<summary>Step by step</summary>
<br>

| Step | Who | What happens |
| :---: | --- | --- |
| 1 | Client | Calls `/mcp` with `Authorization: Bearer <API key or OAuth access token>`. |
| 2 | Server | Checks the key against its hash in `mcp_keys`, or verifies the OAuth token. Then it reads the user's role and scopes from `app_users`. |
| 3 | Server | Lists only the tool groups whose credentials are set and that the user's role allows. |
| 4 | Sources | Reads Drive, Slack, GitHub or Railway. Drive results stay inside your configured folders and skip excluded ones. Slack results stay inside channels the bot is a member of. |

</details>

## Tools

Each tool group appears only when its credentials are set. Each user then sees only the groups their role
allows (see [Access control](#access-control)). All tools only read.

| Tool | What it does | Needs |
| --- | --- | --- |
| `search_drive` | Searches file names, or full text with `mode: "fullText"`, under your Drive roots. Live Drive API query | Drive credentials |
| `read_drive_file` | Reads up to 10 files by ID in one call. Text is cut at `maxChars` (default 50,000). PDFs and Office files come from the index when indexed | Drive credentials |
| `list_drive_folder` | Lists a folder tree under your roots. Up to depth 3, 200 items per folder, 120 folder visits per call | Drive credentials |
| `semantic_search_drive` | Vector search over indexed chunks. Top 5 by default, up to 20 | Qdrant, OpenAI, an index |
| `slack_list_channels` | Channel purpose map from the `slack_channels` table, synced with Slack on each call | Bot token |
| `slack_read_channel` | Recent messages and thread replies of a channel the bot is in | Bot token |
| `slack_find_files` / `slack_get_file` | Finds files shared in the bot's channels and returns the content of text files | Bot token (user token for keyword search) |
| `slack_search` | Message search, limited to channels the bot is in | User token and bot token |
| `repo_tree` | File tree of a repository the GitHub token can read | GitHub token |
| `github_*` | Read-only tools proxied from GitHub's remote MCP server. Tools that change anything are hidden and refused | GitHub token |
| `railway_services` / `railway_deployments` / `railway_logs` | Projects, deployments and logs. Secrets in log lines are masked | Railway token |
| `ping` | Health check that also shows who you are signed in as | None |

## Configuration

Settings live in two places on purpose.

| Layer | Where | What |
| --- | --- | --- |
| Secrets | Environment variables (`.env` locally, host env vars in production) | Keys and tokens. [`.env.example`](.env.example) lists every variable the code reads, with defaults |
| What to look at | `mcp.config.json` | Drive folders, exclusions, Qdrant collection, Supabase schema, login allowlist. See [`mcp.config.example.json`](mcp.config.example.json) |

The config is read from the first of these that exists: `MCP_CONFIG_JSON` (inline JSON), `MCP_CONFIG_PATH`
(file path), `./mcp.config.json`, then built-in defaults. With no config, the server starts with no Drive
roots and no login allowlist, and says so in the boot log.

| Config key | Meaning |
| --- | --- |
| `orgId` | Organization identifier carried in the auth context |
| `branding.name` / `branding.instructions` | Server name, and the routing guide the client receives on connect |
| `drive.roots[]` | `{ id, name, source }` folders to index and search. `source` is `dev` (Markdown with frontmatter) or `biz` (PDF, Office and Google files) |
| `drive.excludeFolders[]` | Folder names skipped everywhere: index, search, read and list. Case and spacing are ignored. Built-in exclusions such as `node_modules` and `.git` always apply |
| `qdrant.collection` | Vector collection name. Env `QDRANT_COLLECTION` overrides it |
| `data.schema` | Supabase schema holding the server's tables (default `public`) |
| `selfDomains[]` | Your own domains. Reserved; the current tools do not read it |
| `oauth.allowedDomains[]` / `oauth.allowedEmails[]` | Who may sign in with Google. Env `OAUTH_ALLOWED_HD` and `OAUTH_ALLOWED_EMAILS` override them |
| `access.viewerTools[]` | Tool groups (`drive`, `slack`, `github`, `railway`) for signed-in users without an `app_users` row. Default: none |

## Access control

**Who someone is** comes from an API key or a Google sign-in. **What they can read** comes from their row
in `app_users`. Signing in alone grants nothing beyond `ping`.

| `app_users` row | Role | What they can use |
| --- | --- | --- |
| `role = 'admin'` | admin | Every tool |
| Any other `role` value | engineer | Tool groups in `allowed_tools`, Drive folders in `allowed_drive_folders`, Slack channels in `allowed_slack_channels`. An empty column means no limit on that dimension |
| No row | viewer | Only `ping`, unless `access.viewerTools` opens tool groups |

<details>
<summary>API keys</summary>
<br>

1. Keys are stored only as SHA-256 hashes in `mcp_keys`. Use long random keys.
2. Set `active = false` or `expires_at` to revoke a key. A revoked key keeps working for up to
   `AUTH_CACHE_TTL_MS` (60 seconds by default).
3. A key with an `email` takes its role and scopes from `app_users`, so removing that row demotes the key.
   A key without an email uses its own `role` column.
4. Failed authentication is rate-limited per client IP (20 per minute by default). Set `TRUST_PROXY` to
   match your proxy setup so the IP is real.

</details>

<details>
<summary>OAuth for Claude web connectors</summary>
<br>

Set the OAuth variables and an allowlist to turn on a built-in OAuth 2.1 server that signs users in with
Google. It shows a consent page naming the app and where the token goes before anything is issued.
Without the variables the server uses API keys only. The full guide is [`OAUTH_SETUP.md`](OAUTH_SETUP.md).

</details>

<details>
<summary>What each data source can reach</summary>
<br>

| Source | Boundary |
| --- | --- |
| Drive | Files under `drive.roots`, minus `drive.excludeFolders`, minus folders outside the user's `allowed_drive_folders`. A file ID outside the roots is refused |
| Slack | Channels the bot is a member of. Direct messages are never read. The user token is used only for search, and its results are filtered to the bot's channels |
| GitHub | Whatever the token can read. Give the fine-grained token only the repositories every user may browse |
| Railway | Whatever the token can read. Prefer a project token over an account token |

</details>

## Indexing

`semantic_search_drive` reads from a Qdrant index of your Drive roots.

| Task | How |
| --- | --- |
| First full index | `docker compose run --rm reindex`, or `npm run reindex` from source |
| Keep it fresh | The server syncs Drive changes every 30 minutes (`DRIVE_SYNC_INTERVAL_MIN`). It starts tracking from its first run, so do the full index first |
| Clean up | A full run deletes vectors of files no longer listed, such as files moved into an excluded folder. Runs limited with `--root`, `--dev-only` or `--biz-only` skip this step |
| Start over | `--recreate` empties the collection first. `--dry-run` only counts chunks |

<details>
<summary>Formats and limits</summary>
<br>

| Format | How text is extracted |
| --- | --- |
| Markdown, plain text | As is |
| Google Docs, Slides | Drive export |
| Google Sheets | Drive export as CSV. Only the first sheet |
| Word, PowerPoint, Excel | Local parsers |
| PDF with a text layer | Local parser |
| Scanned PDF, PNG, JPEG, WebP | Mathpix OCR, only when `MATHPIX_APP_ID` and `MATHPIX_APP_KEY` are set |

Files larger than `DRIVE_MAX_FILE_BYTES` (50 MB by default) are not read or indexed. Embeddings use
OpenAI `text-embedding-3-small` (1536 dimensions).

</details>

## Deploy

The image is published to GitHub Container Registry by [`.github/workflows/docker.yml`](.github/workflows/docker.yml).

| Tag | Built from |
| --- | --- |
| `ghcr.io/chanthr/knowledge-mcp:latest` | The latest release tag |
| `ghcr.io/chanthr/knowledge-mcp:<x.y.z>` | Release tag `v<x.y.z>` |
| `ghcr.io/chanthr/knowledge-mcp:edge` | The `main` branch |

1. **Any container host.** Run the image with your env vars and either `MCP_CONFIG_JSON` or a mounted
   `/app/mcp.config.json`. [`compose.yaml`](compose.yaml) does exactly this. The host may set `PORT`.
2. **Railway.** [`railway.toml`](railway.toml) builds the Dockerfile and checks `/health`. Put the config in
   `MCP_CONFIG_JSON`, because files that are not in the repository are not in the build.
3. **HTTPS.** Put the server behind HTTPS before remote clients connect. OAuth needs an `https` issuer
   unless it runs on `localhost`.
4. **One replica.** Sessions and pending sign-ins live in memory. Run a single instance, or add sticky
   routing and a shared store yourself.

## Connect a client

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add --transport http knowledge https://<your-host>/mcp --header "Authorization: Bearer <key>"` |
| Claude web and desktop connectors | Turn on OAuth, then add a custom connector with `https://<your-host>/mcp` |
| Any client over stdio | Run the image with `MCP_TRANSPORT=stdio` (example below) |

<details>
<summary>stdio configuration example</summary>
<br>

In stdio mode the server reads one key from `MCP_API_KEY` at startup. For local use, set `MCP_DEV_KEY` and
`MCP_API_KEY` to the same value in `.env`; that key acts as an admin and works only in stdio mode.

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/.env",
        "-e", "MCP_TRANSPORT=stdio",
        "-v", "/absolute/path/mcp.config.json:/app/mcp.config.json:ro",
        "ghcr.io/chanthr/knowledge-mcp:latest"
      ]
    }
  }
}
```

</details>

## Security notes

1. Never commit `.env`, `google-service-account.json` or `mcp.config.json`. All three are gitignored and
   kept out of the image.
2. Run [`sql/setup.sql`](sql/setup.sql) again after every upgrade. It turns on row-level security and
   removes the `anon` and `authenticated` grants, so only the service-role key can touch the tables.
3. The server does not change Drive, Slack, GitHub or Railway. It writes only its own Supabase tables and
   the Qdrant index.
4. Indexing sends document text to OpenAI for embeddings, and scanned files to Mathpix when OCR is on.
5. A token reaches whatever it can read. Scope the Slack bot, the GitHub token and the Railway token to
   what every user of this server may see.

## File map

| Area | File | Contents |
| --- | --- | --- |
| Server | [`src/index.ts`](src/index.ts) | Entry point: HTTP and stdio transports, authentication, tool routing |
| Server | [`src/tools/`](src/tools/) | One file per tool |
| Server | [`src/lib/`](src/lib/) | Auth, OAuth, scopes, config, indexing, Qdrant, text extraction |
| Server | [`src/integrations/`](src/integrations/) | Drive and Slack API clients |
| Indexing | [`scripts/index_drive.ts`](scripts/index_drive.ts) | Full Drive reindex |
| Indexing | [`scripts/get_oauth_refresh_token.ts`](scripts/get_oauth_refresh_token.ts) | One-time Drive OAuth token helper |
| Database | [`sql/setup.sql`](sql/setup.sql) | Tables, key check function and lock-down |
| Settings | [`.env.example`](.env.example), [`mcp.config.example.json`](mcp.config.example.json) | Every environment variable, and the config file template |
| Deploy | [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml), [`railway.toml`](railway.toml) | Image, local stack, Railway |
| Docs | [`OAUTH_SETUP.md`](OAUTH_SETUP.md) | OAuth setup and roles |
| Repository | [`.github/`](.github/) | Image workflow, issue and PR templates, README images (`assets/make.py` rebuilds them) |

## Contributing

Please open an issue for problems and ideas.

| Template | Use it when |
| --- | --- |
| [**Bug report**](https://github.com/chanthr/internal-mcp/issues/new?template=01-bug.yml) | Something behaves differently from the code or the docs |
| [**Improvement**](https://github.com/chanthr/internal-mcp/issues/new?template=02-improvement.yml) | You have a better way, or a doc no longer matches the code |

This repository is public. Leave API keys, tokens, internal URLs and private documents out of issues and
pull requests. Report security problems privately with
[**Report a vulnerability**](https://github.com/chanthr/internal-mcp/security/advisories/new) on the Security tab, not in an issue.

## License

[MIT](LICENSE) © chanthr
