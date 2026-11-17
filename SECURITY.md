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
| Slack, GitHub, Railway | A token reaches whatever it can read. Scope each token to what every user may see |
| Access | Unregistered users get only `ping` unless `access.viewerTools` opens more. Per-user tool, folder and channel limits live in the users table |
| Embeddings and OCR | With an embedding model set (`OPENAI_API_KEY` in the environment counts), indexing sends passage text, and search sends the question, to that provider. Without one nothing leaves the machine for search. Scanned Drive files go to Mathpix when OCR is on |
| Data file | Holds key hashes and OAuth client secrets. It is created owner-only; keep the volume private |
| Logs | Known secret values and common token shapes are masked, but do not treat logs as public |

Never commit `.env`, a service-account JSON, `mcp.config.json` or `data/`.
