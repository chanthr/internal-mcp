# Security

## Reporting a vulnerability

Report it privately with
[**Report a vulnerability**](https://github.com/chanthr/internal-mcp/security/advisories/new) on the Security tab.
Please do not open a public issue.

Include the version, how the server is deployed (stdio, HTTP, Docker), and the steps that show the problem.
Leave real keys, tokens and documents out of the report.

## Supported versions

Fixes go into the latest release. Upgrade to it before reporting, in case the problem is already fixed.

## What the server can reach

The server reads with the credentials you give it, on behalf of everyone who can call it. Keep this in mind
when you set it up.

| Area | What to know |
| --- | --- |
| Drive | Anyone who knows the service account's address can share a document with it; Drive asks nobody. Documents shared outside `drive.roots` are therefore shown only when the top shared item belongs to an owner in `drive.trustedOwners`. Keep that list to your own organization. What a trusted owner shares is visible to every user who may use the `drive` tools: list sensitive folder names in `drive.excludeFolders`, or set `drive.scope` to `roots` |
| Local folders | Every supported file under a folder in `folders` is searchable and readable by every user who may use the `knowledge` tools. Add only folders meant for all of them; names in `drive.excludeFolders` are skipped, symbolic links are not followed, and a document id cannot reach a file outside the folder |
| Databases (`connections`) | A connection reads whatever its database user can read, and with `explore` the caller writes the query. Give the connection a user of its own that can only read and that sees only what every permitted person may see. Never a superuser (a superuser can read server files through SQL functions), and not the user your application runs as (a query can end other sessions of its own user). Read-only is enforced by the database: a read-only transaction that accepts one statement (Postgres), a read-only file handle and a check of the statement SQLite compiled (SQLite). Advisory locks a query takes are released before the connection is reused. The connection's name is its permission group, and a member without a tool list may use every group |
| APIs (`connections`) | A declared request reaches one host and base path with the credentials you configured; parameters cannot change the destination and redirects are not followed. Write secrets as `${ENV_NAME}` in header and query values, never in the config file. Those values are masked in what the caller gets back, in plain and URL-encoded form; an API that returns them transformed (base64, a hash) is not covered |
| Slack, GitHub, Railway | A token reaches whatever it can read. Scope each token to what every user may see. The gh login can do what `gh` can: on a server other people use, prefer a fine-grained read-only token. A Railway sign-in asks for viewer access to the workspaces you pick |
| Sign-ins from the console | Kept in the data directory (`railway-login.json`, `google-login.json`), owner-only. A Google sign-in reads as the person who signed in: what is in the chosen folders is visible to every user. The page a sign-in returns to (`/console/login/…`) takes no console token, because the browser arrives from the other site; it accepts a code only together with a one-time `state` the console handed out in the last ten minutes, proves it with PKCE, and writes nothing. Saving is a separate call that needs the console token. Disconnecting deletes the file and withdraws the permission at the other site |
| Console | The page at `/console/` changes settings and runs tools as the admin. It exists only when the server was started in a terminal or with `KNOWLEDGE_CONSOLE=on` (`off` removes it). It answers a browser on the same machine asking for `localhost`: another address, a forwarding header, another host name, or a request the browser marks as another site's is refused. Its API needs the token in `<data dir>/console-token` (owner-only; a file others could read is replaced), and the page never shows a secret it was given. The token is the admin's key: its holder can change settings and can declare a connection that sends a `.env` secret to an address they choose. The console refuses a `${NAME}` that names the server's own credentials or a variable inherited from the shell, and values with line breaks. A reverse proxy on the same machine that adds no forwarding header (nginx's plain `proxy_pass`) cannot be told from a local browser: on a server, keep the console off. Every user of a shared machine can reach `localhost`; the token file is what keeps them out |
| Access | Unregistered users get only `ping` unless `access.viewerTools` opens more. Per-user tool, folder and channel limits live in the users table |
| Embeddings and OCR | With an embedding model set (`OPENAI_API_KEY` in the environment counts), indexing sends passage text, and search sends the question, to that provider. Without one nothing leaves the machine for search. Scanned Drive files go to Mathpix when OCR is on |
| Data file | Holds key hashes and OAuth client secrets. It is created owner-only; keep the volume private |
| Logs | Known secret values and common token shapes are masked, but do not treat logs as public |

Never commit `.env`, a service-account JSON, `mcp.config.json` or `data/`.
