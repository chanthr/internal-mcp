# Changelog

Changes that affect people who run or extend the server. Dates are release dates.

## 0.4.0

### Changed

- **Search needs no key: `search_knowledge` replaces `semantic_search_drive`.** The built-in index now holds a
  keyword index (BM25) next to the vectors, so search works with nothing configured and in any language (Korean,
  Japanese and Chinese are matched by character pairs). An embedding model adds search by meaning; the two result
  lists are merged by rank, and when the embedding endpoint is down search answers from keywords and says so.
  `read_document` reads a result by its Document ID. Both tools belong to the new plugin `knowledge`: add
  `knowledge` where a person's tools or `access.viewerTools` list `drive`.
- **Documents shared by a trusted owner are in scope, wherever they are.** A folder or document that an owner in
  `drive.trustedOwners` shared with the service account can be searched, read and indexed without being under
  `drive.roots`. The list is empty by default, so an upgrade changes nothing until you add your organization
  (`knowledge-mcp setup trust acme.com`; the setup wizard asks). The owner check exists because anyone who knows a
  service account's address can share a document with it. Excluded folders stay hidden wherever they are, and a
  document whose parent folders cannot be checked is hidden. `drive.scope: "roots"` turns the feature off.
  `drive reindex` now runs with no roots configured.
- **zod 4.** The exported `z` is zod 4. In your plugins change `z.record(valueSchema)` to
  `z.record(z.string(), valueSchema)`, and an object `.default({})` that relies on inner defaults to `.prefault({})`.
- **`source` is a free label.** Each Drive root names its own (`handbook`, `sales`, …; default `docs`) and
  `metadata` chooses where document metadata comes from (`path` or `frontmatter`). `dev` and `biz` keep their old
  meaning. `drive reindex --source <label>` replaces `--dev-only` and `--biz-only`, which still work.
- **Full-text search returns the best match first.** `search_drive` no longer forces newest-first on full-text
  queries. Title search stays newest-first.
- **Search shows at most 2 passages per document** (`KNOWLEDGE_MAX_PER_DOC`), so one long document no longer
  fills every result. Each result says how many more matching passages its document has.

### Added

- **Local folders as a source.** `knowledge-mcp setup folder <path>` (or `folders` in the config, or the first
  question of the setup wizard) makes a folder of Markdown, text, PDF, Word, PowerPoint and Excel files searchable:
  no account, no key. The server scans it when it starts and on a timer, opens only files that changed, and removes
  documents whose file is gone. A document id cannot be used to read outside the folder.
- **Add or change the embedding model any time.** Passages indexed without a model get their vectors on the next
  scan or sync; no document is read again. After changing the model, `knowledge-mcp knowledge reembed` makes new
  vectors from the stored text. Vectors of two models are never mixed: until then search answers by keywords.
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
- **No vector database to run.** The index (text, keyword index, vectors) is the file `<data dir>/vectors.db`
  when `QDRANT_URL` is not set. Qdrant stays available for larger indexes; it holds vectors only, so it needs an
  embedding model.
- **The first index builds itself.** The server indexes Drive the first time it starts with an empty index, over
  HTTP or in a stdio session. It checks the embedding endpoint first when one is set and never uses paid OCR on its own
  (`drive reindex` does; `--no-ocr` skips it). `DRIVE_AUTO_INDEX=false` turns the automatic build off.
- **stdio sessions stay current and cannot be broken by a stray `console.log`.** A session syncs Drive once when it
  starts (new plugin hook `catchUp`), a lock file keeps parallel processes from syncing twice, and anything a
  plugin prints to stdout is sent to stderr so the protocol stream stays intact.
- Search results show the document date, or the modified date with the document's age.
- **Any OpenAI-compatible embedding endpoint**: `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`,
  `EMBEDDING_API_KEY`. A local server needs no key. The default is still OpenAI `text-embedding-3-small`.
  With Qdrant, a collection whose vector size differs from `EMBEDDING_DIM` stops indexing with the fix in the message.
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
