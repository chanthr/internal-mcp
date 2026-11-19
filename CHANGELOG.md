# Changelog

Changes that affect people who run or extend the server. Dates are release dates.

## 0.4.0

### Changed

- **The read-only gateway goes by what a remote says about its tools.** A tool the remote marks as read-only
  (`readOnlyHint`) is shown whatever it is called, and one it marks as changing things is hidden even when its
  name starts with a read verb. A tool without a mark is judged by its first word as before, now skipping the
  service's own name in front (`notion-search` reads as `search`). An upstream you already list may show a few
  tools more or fewer; `expose` still overrides.
- **What a model reads costs less.** `search_knowledge` shows two neighbouring parts of a document as one passage
  instead of twice the same edge, says how many terms of the question each passage holds, calls a poor keyword
  match weak, and answers a filter that matched nothing with the values that field has. `read_document` reads
  around a part (`part`, `around`) or continues a long document (`offset`), returns plain text instead of JSON,
  and its default `maxChars` is 20,000 (was 50,000). Over 24 questions on a 500-file corpus the same documents
  were found with 22% less text. A tool on a database returns rows as a compact table (column names once, one
  row per line): about a third of the size of rows as indented objects.
- **A value a tool returns is sent as compact JSON.** A plugin that returns an object used to get it indented.
  The value is the same; a client that showed the text to people may want to format it.
- **`setup check` asks every service at the same time.** The lines come out in the same order; the wait is the
  slowest service, not the sum of all.
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

- **A knowledge graph, read from the links people wrote.** Documents in the local folders are connected by
  their wiki links (`[[Note]]`, as Obsidian writes them), their Markdown links to documents and the header fields
  that name documents (`related`, `parent`, any field). No model is involved, and an Obsidian vault added as a
  folder brings its graph with it. The new tool `linked_documents` follows the links from a document in both
  directions, or lists the documents most others link to; `search_knowledge` says which results are linked. The
  console has a *Graph* page: the numbers, a view around any document, and the loose ends (links to a document
  that is not there, documents nothing links to). On a 500-file wiki the links are read in 0.14 s and the graph
  is built in 6 ms; only a document that changed is read again.
- **Drop files on the console.** *Documents* takes files and whole folders by drag and drop (or a file picker).
  They are copied into `uploads/` beside the settings, which becomes a folder like any other: searchable and
  part of the graph. Only the file types that can be searched are taken. Reading a folder of PDFs takes a
  while, so the page shows how far it is ("Reading the files: 70 of 213") and, when it is done, how many
  documents there are and which files had nothing to read in them (scanned pages) or would not open.
- **Add an app that has an MCP server of its own.** In the console, *Apps → Add an app*: pick Notion,
  Supabase, Linear, Atlassian, Sentry, Vercel, Stripe, Airtable, Figma and others from a list, or give the
  address of any MCP server. Where the server follows MCP's sign-in rules, this server registers itself there
  and you sign in at the app: nothing to create, no token to copy. The gateway uses that sign-in and renews it
  by itself (`"signIn": true` on the entry in `upstreams`). Only the app's tools that read are turned on, with a
  switch per app to allow the rest; Supabase is added in its read-only mode. A token can be pasted where a
  service gives one, and an open server needs nothing.
- **Connect a service without copying a token.** In the console: *Sign in with Railway* (the server registers
  itself with Railway, you pick the workspaces it may read as a viewer, and the sign-in renews itself; a sign-in
  that shares no workspace is not kept, and the page says to pick one; a viewer sees projects and deployments
  but not logs, and `railway_logs` says so and that a token reads them), *Sign in
  with Google* for Drive (through an OAuth client of your own Google Cloud project, made once; the server reads
  your My Drive or the folders you list), *Account with gcloud* (creates the Drive service account and its key
  without stopping the server while gcloud works), *Use the gh login* for GitHub, and for Slack a link that opens
  "Create an app" with the read-only permissions filled in. A token can still be pasted for each, and
  `RAILWAY_TOKEN` wins over a sign-in. A sign-in is kept owner-only in the data directory and goes, together with
  the permission at the other site, when the service is disconnected.
- **A console in the browser.** Start the server in a terminal and open the address it prints
  (`npx @chnxthr/knowledge-mcp` in any folder opens it for you). Add folders, connect Drive, Slack, GitHub,
  Railway, a database or an API, write a query and save it as a tool, try any tool and see what a client gets
  back, add the server to Claude Code, Claude Desktop, Cursor or VS Code with one button, pick or change the
  embedding model (new vectors are made from the stored text, with the progress shown), manage people and keys,
  and see the latest calls. It writes the same `.env` and `mcp.config.json` as the setup commands, through the same live
  checks, and a saved change restarts the server by itself. It is served only when the server was started in a
  terminal (or with `KNOWLEDGE_CONSOLE=on`), only to a browser on the same machine asking for `localhost`, its
  API needs a token created on first start, and the page never shows a secret. `KNOWLEDGE_CONSOLE=off` turns it
  off; `KMCP_SUPERVISE=false` keeps the server from restarting itself.
- **`MCP_HOME`.** One variable names the folder of `.env`, `mcp.config.json` and the data. A client's entry sets
  it when the server is started through npx, so the settings are found whatever folder the client runs in, and
  the `.env` of that folder is not read.
- **Your data as tools, without a plugin file.** `connections` in the config names a Postgres database, a SQLite
  file or an HTTP API; `tools` declares one SQL query or one API request each, with typed parameters. Values are
  bound by the driver, a read-only tool runs in a read-only transaction (SQLite: a read-only file) with a row limit
  and a time limit, and an API tool cannot leave its base URL. `setup check` connects and compiles every declared
  query without running it. `setup connection` and `setup secret <ENV_NAME>` set a connection up without a secret
  ever being an argument, and the setup wizard has a Database step.
- **`explore`: let the assistant write the queries.** With `"explore": true` a database connection also offers
  `<name>_tables` and `<name>_query` (one read-only SELECT). Off by default: it reads whatever the database user
  can read.
- **Local folders as a source.** `knowledge-mcp setup folder <path>` (or `folders` in the config, or the first
  question of the setup wizard) makes a folder of Markdown, text, PDF, Word, PowerPoint and Excel files searchable:
  no account, no key. The server scans it when it starts and on a timer, opens only files that changed, and removes
  documents whose file is gone. The text is indexed first and vectors are made afterwards, so keyword search covers
  the folder within seconds even when an embedding model is set. A document id cannot be used to read outside the
  folder.
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

### Dependencies

- Added `pg` (the Postgres driver), loaded on first use by a Postgres connection.

### Fixed

- **When gcloud's sign-in has expired the console says what to run.** With an organization account Google asks
  for the sign-in again after a while, and gcloud, started by the console, has no terminal to ask in. Pressing
  *Account with gcloud* then showed gcloud's own sentence ("Reauthentication failed. cannot prompt during
  non-interactive execution"). Every gcloud step now answers with the command that fixes it: `gcloud auth login`.
- **The server no longer starts on a port another program already answers on.** It listens on every address,
  and the system allows that beside a program that listens on 127.0.0.1 only. The two then shared the port: a
  browser on `localhost` reached one or the other, and the console asked for its token over and over because the
  other program answered "not allowed". The server now says which port is taken and how to pick another, and
  does not start.
- **The console address is printed after every start**, not only the first, so it is the last thing in the
  terminal after a restart. The page that asks for the token says which line to look for and which address the
  token is remembered for.
- **The console no longer asks for the token because something else said "not allowed".** Every answer of the
  console now says it is the console's, and the page takes a refusal for "the token is not accepted" only then.
  An answer from another program on the address (while the server restarts) is treated as no answer: the page
  waits, and says the server is not answering if it does not come back.
- **The line the generator prints for Claude Code broke in a folder with a space in its path.** Pasted as
  printed, `claude mcp add` took half the path as the command and the server never started ("ENOENT"). Paths are
  quoted now, Node is named by its full path, and the entry is added for the user rather than for the folder
  the command happened to be run in. The setup wizard quotes its line the same way.
- **The built-in index no longer reads everything to answer small questions.** Asking how many passages have a
  vector loaded every vector into memory, and it was asked on every search and every status read. With 90,000
  passages the server held 1.7 GB after start and 5.6 GB while vectors were being made; it now holds 180 MB after
  start and 360 MB. Making vectors for those passages (the index's own share, with an instant model) went from
  80 s to 8 s, a status read from 120 ms to 11 ms, a keyword search from 20 ms to 6 ms, a pass over an unchanged
  folder from 1.2 s to 0.3 s.
- **A keyword search with a filter looked only at the best 2,000 matches.** A document further down that passed
  the filter was not found. The ranking is now read until enough pass.
- **`knowledge reembed` could leave the index almost without vectors.** Run while another run was filling in
  vectors, it dropped them and stopped. It now drops nothing unless it is the run that makes the new ones. A
  large index is also filled in one go, not 20,000 passages per scan.
- **Text put back together from the index repeated itself.** A PDF or Office document read with `read_document`
  showed up to 100 tokens twice at every boundary between two parts.
- **`search_knowledge` no longer offers Drive's `source` labels when Drive is not connected.**
- **A value written to `.env` stays one variable.** A value with a carriage return, or a quoted value ending in a
  backslash, could run on into the next line of the file when it was read back. Line breaks are now escaped, such
  a value is written without quotes, and one that cannot be written safely is refused.
- **A request body that is not JSON gets a one-line answer.** It used to be answered with a stack trace.
- **Hints name commands that run where you are.** Messages said `knowledge-mcp setup check`, which is not on the
  PATH of a generated project. They now say `npm run setup -- check` there, `npx @chnxthr/knowledge-mcp …` under npx,
  and `knowledge-mcp …` in the Docker image.
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
