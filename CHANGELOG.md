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

- **Skills, and notes in your own font.** The Skills page installs skills (Agent Skills format) from GitHub or a
  folder, or writes one; every assistant that uses the server is told their names and reads one with `use_skill`
  when a task calls for it. Nothing in a skill is run. The Notes page lists `notes/` and `inbox/`, shows a note in
  a font you add, and prints it or saves it as a PDF.
- **Conversations are kept, and notes are saved.** Chat keeps its conversations on this computer and picks them
  up again from a list; leaving the page no longer loses them or stops an answer. `save_note` writes a Markdown
  note into `notes/` (from the console's chat) or `inbox/<who>/` (from other assistants), never over another file
  and never into your documents; both folders are indexed without being configured. `POST /inbox` takes a note
  from a program with a member's key, such as a browser agent's routine.
- **Vectors keep up by themselves.** The folders are watched: a file saved, added or removed is read within
  seconds instead of at the next 10-minute pass (`KNOWLEDGE_WATCH=false` turns it off). Vectors that could not
  be made are tried again after 1, 5 and 15 minutes, and Models → Search by meaning says why. An embedding model on
  this machine gets batches of 32 and a 120-second timeout by default (they used to time out at 10 seconds on a
  busy laptop). With no embedding model set, the page says how many passages already have vectors and from which
  model.
- **The wiki keeps itself up to date.** *Keep the wiki up to date* on the Wiki page reads documents that are
  added or changed from then on, after each scan, up to 50 a day; what was waiting stays for the button. Pages are
  written as each document is read (a restart in the middle used to leave what was read without pages), missing
  pages are written again from what was kept, a busy model is asked again after a pause, and documents that could
  not be read are listed with why. A ChatGPT plan is now retried like an API endpoint (`LLM_RETRY_MS`).
- **A search assistant: `find_documents`.** With a model connected, a question can be handed to a model that
  searches several times with different words, reads where an excerpt is not enough, and returns the documents
  that answer it, best first, each with a line on what it holds (it answers nothing itself). `effort` sets how
  hard it looks; `high` splits the question into its parts and searches them at once. It sees what
  `search_knowledge` and `read_document` would show the person asking, and no more. The Models page can give it a
  model of its own (`SEARCH_LLM_*`), such as a small local one while Chat uses a hosted one, and measuring search
  (Search → Passages, or `knowledge measure --agent`) can ask it the same questions, now scored by NDCG and recall
  as well, with several right documents per question allowed.
- **A public address from your own machine (Cloudflare Tunnel).** *Connect a client → Other people* gives the
  server an https address without moving it: a temporary one (`…trycloudflare.com`, no account, for trying it
  out) or your own (`mcp.example.com`, on a domain in your Cloudflare account). The console installs cloudflared,
  runs its sign-in, makes the tunnel and its DNS record (an existing record is never written over), starts it,
  and brings it back when the server is started again. `/mcp` asks for a key as before, and the console is not
  reachable through the tunnel (403). Your own cloudflared config and tunnels are not touched.
- **A wiki written from your documents.** With a model connected, *Agent → Create the wiki* makes `wiki/`
  beside the settings, and *Read documents* fills it: one page per document (what it says, the topics it feeds)
  and one page per topic that gathers what all the documents say, each fact with the document it comes from,
  plus an index and a log. Plain Markdown with `[[links]]`, so it is searched and linked like any folder here
  and opens in Obsidian as it is. `AGENTS.md` in the folder holds the rules and is yours to change. Only new and
  changed documents are read, a press reads up to 25 and reports the questions and tokens it came to, and notes
  under `## Notes` are kept. The model is asked for labelled lines instead of JSON: with a local
  8-billion-parameter model, JSON lost three documents of five and labelled lines lost none.
- **Connect a language model (the Agent page).** For work the server does by itself, a model can be connected
  in the console: Claude through Anthropic's API, OpenRouter, OpenAI, a local model through Ollama, or any
  endpoint that speaks OpenAI's chat completions. The model is picked from the provider's own list, checked with
  one question, and its key saved in `.env` (`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`). Until
  one is connected the server calls no model, as before. For Claude, instructions that repeat between calls are
  marked to be cached, and on the models that support it a declined request is handed to another model by
  Anthropic within the same call.
- **"Open the console" where the page asks for the token.** A browser that has no token yet (another browser,
  another port) no longer sends you to find an address in the terminal: one button, and the server opens the
  console in your default browser, signed in. The one who asks is handed nothing, and the one-time address is
  kept off the command line (which other users of a machine can read) on macOS and Linux, at start as well.
- **Railway: reading logs is a choice at sign-in.** A viewer sees projects and deployments but not logs (seen
  with a real sign-in). *Also read logs* asks Railway for member access instead, said plainly because a member
  could also change things. The default stays viewer.
- **The console installs and signs in the command-line tools it leans on.** *Account with gcloud* and the gh
  login used to need a tool that was already installed and signed in, and said "in a terminal: …" otherwise. The
  console now runs those commands itself: the package manager's install (`brew install gh`,
  `brew install --cask gcloud-cli`, winget on Windows), `gcloud auth login` (a browser window opens) and
  `gh auth login --web` (the page shows the code to type at github.com). For GitHub one button goes from "gh is
  not on this machine" to connected. The commands are fixed, an install is shown before it runs, and nothing typed
  into the page reaches a command line. When Google asks an organization account to sign in again, the page
  offers the sign-in instead of gcloud's error.
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

- **Found by a security review of what 0.4.0 adds, and closed.**
  - *One Markdown file could stop the server.* Reading a document's links used patterns that took time with the
    cube of a run of spaces after a heading (4,000 spaces: 19 s; more: hours), in the scan that every request
    waits for. Links are now read in time proportional to the text, a document is read for links up to 4 MB,
    and a test holds each hostile shape under a time limit.
  - *An MCP server could borrow another service's sign-in.* A server added from the console says where to sign in
    and for which address. One that named another service's address would have been handed what the person
    allowed there. The address it names must now be its own, and when the sign-in happens at another owner's
    site the console says both names and asks before going there.
  - *A server's sign-in could send this server into the network behind it.* The addresses it gives for
    registering and for the token must be https addresses on the internet, unless the MCP server is itself on
    this machine.
  - *`linked_documents` told a document that is hidden from one that is not there.* For someone limited to some
    folders, a link out of them is now listed exactly like a link to a document that does not exist.
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
- **A note of blank lines or spaces no longer stops the server.** Cleaning text tried some patterns again from
  every line or every space: one 200,000-character note sent to `POST /inbox` held every client for 17 to 98
  seconds. Text is now cleaned in time proportional to its length (200,000 blank lines: 17 s before, under 5 ms
  now), and ordinary text comes out as before.
- **One long word no longer stops the server while it is cut into passages.** The tokenizer's work on a run with no
  space in it grows with the square of its length, and the chunker counted the same text several times and again
  at every step of a search: 8,000 Korean characters without a space took 1 s, 100 KB of "a" 29 s, 100 KB of "|"
  50 s. Text is now counted word by word, each word once per document, and a run of more than 768 bytes with no
  word end in it in pieces of 32 characters (each of those cases now takes under 50 ms).
- **No passage is larger than the size it is cut to.** Sentences, paragraphs, table rows and small sections were
  packed by the sum of their own sizes, and joined they could come to more: 4,000 short release notes in a row made
  one passage of 62,000 tokens, more than an embedding model takes, and ordinary text went a few tokens over in 8%
  of passages. A passage is now counted as it is joined and stored, and never goes over (with the overlap from the
  passage before on top, as before). Where a passage went over, it is cut differently now; other passages are the
  same as before.
- **A heading line followed by many spaces no longer stops the server.** The heading pattern tried every split of
  the spaces: 200,000 spaces took 15 s.
- **Front matter with many keys no longer stops the server.** The YAML parser compared every key with every other
  one (40,000 keys: 5 s). Front matter over 64 KB is not read for metadata.
- **A passage of thousands of blank lines is counted for tables in time.** The pattern that counts table rows read
  every blank line on to the end of the run (40,000 lines: 2 to 9 s).
- **A document that contains a special token string such as `<|endoftext|>` is indexed.** The tokenizer refused
  it, and the document was listed as one that could not be indexed. Such strings are now text like any other.
- **Pictures embedded as base64 in Markdown and text files are dropped before indexing**, as they already were for
  Google Docs. A Markdown file with one picture of 1.6 MB took 7.5 s to cut and became 374 passages of letters
  sent to the embedding model. Pictures in code blocks and `inline code` (examples), and pictures under 1 KB, are kept.
- **A `.docx` with paragraphs that never close is read in one pass.** A file of 1.6 KB holding 1 MB of such XML
  took 25 s to read (the 64 MB a part may hold: hours). It now takes milliseconds.
- **An `.xlsx` no longer makes millions of commas out of the size it says it has.** A file of 1.5 KB with one cell
  that said it spanned 200,000 rows by 100 columns became 20 million commas in 4 s, one that said a million rows by
  16,384 columns would have run for an hour, and 1,000 tabs with two cells far apart took 12 s. A tab's own range is
  used when it is no larger than what is left of 2,000,000 cells for the whole workbook, and otherwise the range of
  the cells that are there; only rows that hold a cell are visited, empty rows are left out, a tab is read to
  100,000 rows, and where reading stops a line says so.
- **Comparing ways of cutting no longer holds the server.** It cut 200 sample documents in one go, five ways in a
  row (up to 2.3 s each). Other requests now wait at most one document.
- **The Wiki page no longer lists every folder while a run goes.** It asks how far the run is every 1.5 s, and each
  answer read every file's details again (20,000 files: about 0.2 s each time, for the whole run). While a run
  goes the answer comes from what the run listed when it started; a document added meanwhile is counted when the
  run ends.
- **Listing conversations no longer reads every conversation.** The list was read from all of them after every
  answer (500 conversations of 150 KB: 74 MB, a quarter of a second). It is now kept beside them and made again
  from the files when it is missing, cannot be read, or a file changed.
- **Saving a file no longer makes the next search build the link graph again.** The links file changes whenever a
  document's modified time does, and the next `search_knowledge` built the whole graph again (20,000 documents:
  0.25 s). The graph is now built again only when titles, other names or links change.

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
