# Changelog

Changes that affect people who run or extend the server. Dates are release dates.

## 0.4.0

### Changed

- **Drive scope is `shared` by default.** Every document shared with the service account is searchable, readable
  and indexed, including folders and single documents shared outside `drive.roots`. Sharing a document with the
  account is all it takes. Excluded folders stay hidden wherever they are, and a document whose parent folders
  cannot be checked is hidden. Set `drive.scope` to `roots` (or env `DRIVE_SCOPE=roots`) for the 0.3 behaviour.
  `drive reindex` now runs with no roots configured.
- **zod 4.** The exported `z` is zod 4. In your plugins change `z.record(valueSchema)` to
  `z.record(z.string(), valueSchema)`, and an object `.default({})` that relies on inner defaults to `.prefault({})`.
- **`source` is a free label.** Each Drive root names its own (`handbook`, `sales`, …; default `docs`) and
  `metadata` chooses where document metadata comes from (`path` or `frontmatter`). `dev` and `biz` keep their old
  meaning. `drive reindex --source <label>` replaces `--dev-only` and `--biz-only`, which still work.
- **Full-text search returns the best match first.** `search_drive` no longer forces newest-first on full-text
  queries. Title search stays newest-first.
- **Semantic search shows at most 2 chunks per document** (`SEMANTIC_MAX_PER_DOC`), so one long document no longer
  fills every result. Each result says how many more matching chunks its document has.

### Added

- **Guided setup: `knowledge-mcp setup`.** Asks which services to connect, checks every key against the real
  service as it is entered (Drive shows what is shared with the account, the embedding size is read from the
  endpoint), writes `.env` and `mcp.config.json`, creates the admin key and offers to add the server to Claude
  Code. `create-knowledge-mcp` runs it after install. No file has to be edited by hand.
- **Sign in instead of clicking through consoles.** With the gcloud CLI, setup creates the Drive service account,
  enables the Drive API and downloads the key (it shows the commands and asks first). With the gh CLI signed in,
  it can reuse that login.
- **Setup for scripts and AI agents.** `setup check` verifies every configured service live. `setup drive --gcloud`,
  `setup drive --key`, `setup github --from-gh` and `setup embeddings` ask nothing and never take a secret as an
  argument. A generated project includes `AGENTS.md`, a setup guide an agent can follow.
- **Semantic search without a vector database.** Vectors are stored in `<data dir>/vectors.db` when `QDRANT_URL`
  is not set, so an embedding key is the only thing to supply. Qdrant stays available for larger indexes.
- **The first index builds itself.** The server indexes Drive the first time it starts with an empty index.
  `DRIVE_AUTO_INDEX=false` turns that off.
- **Any OpenAI-compatible embedding endpoint**: `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`,
  `EMBEDDING_API_KEY`. A local server needs no key. The default is still OpenAI `text-embedding-3-small`.
  A collection whose vector size differs from `EMBEDDING_DIM` stops indexing with the fix in the message.
- `drive.sharedSource`: the `source` label for documents shared outside the roots (default `shared`).

### Fixed

- **Install warnings and audit findings are back to zero.** A new project printed "2 high severity
  vulnerabilities" (zod 3 has no patched release). Dependencies are updated and `npm audit` is clean.
- **Google Sheets are read tab by tab.** Only the first tab was read and indexed.
- **Google Docs with pictures are read in full.** The Markdown export carries pictures as base64, which used up
  `maxChars` and cut the text short. Picture data is now removed.

## 0.3.2

Review fixes: OAuth consent bypass, full-index wipe on an empty listing, permission escalation paths, retry list for
failed files, 503 instead of 401 on a store outage, session caps, documentation gaps.

## 0.3.1

No install warnings: replaced googleapis, the Qdrant client, mammoth and officeparser with small built-in clients
and parsers.

## 0.3.0

Plugin architecture, the `create-knowledge-mcp` generator, SQLite as the default store, the `knowledge-mcp` CLI.

## 0.2.0

Deny-by-default permissions, OAuth consent page, locked-down Supabase tables, Docker image.
