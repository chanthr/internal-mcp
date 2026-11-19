<h1 align="center">
  <img alt="Knowledge MCP" src=".github/assets/banner.svg" width="100%">
</h1>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src=".github/assets/badge-license.svg"></a>
  <a href="#quick-start"><img alt="node: 22.13+" src=".github/assets/badge-node.svg"></a>
  <a href="#connect-a-client"><img alt="MCP: HTTP + stdio" src=".github/assets/badge-mcp.svg"></a>
  <a href="#access-control"><img alt="auth: Key + OAuth" src=".github/assets/badge-auth.svg"></a>
</p>

<p align="center">
  <b>Build your team's own MCP server. Install with one command, add a tool with one file.</b><br>
  API keys, Google sign-in, per-person permissions and an audit log are already done.<br>
  Document search (local folders, Google Drive), Slack, GitHub and Railway come built in.<br>
  A database or an API becomes tools from a few lines of config.
</p>

<p align="center">
  <b>English</b>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#add-a-tool">Add a tool</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#plugin-api">Plugin API</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#built-in-plugins">Built-in plugins</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#access-control">Access control</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#deploy">Deploy</a>
</p>

## Quick start

Pick the path that matches what you want. Both start with no database to set up: state lives in a local
SQLite file. You need Node 22.13 or later, or Docker.

| You want | Start with |
| --- | --- |
| **To click through it in a browser** | `npx @chnxthr/knowledge-mcp` in any folder. [The console](#the-console) opens |
| **Your own tools** (internal APIs, databases, anything) | `npx create-knowledge-mcp my-mcp` |
| **Questions about your database or API**, no code | [Your data as tools](#your-data-as-tools): a connection and a query in the config |
| **Only the built-in connectors** (Drive, Slack, GitHub, Railway) | The Docker image |

**Your own tools**

```bash
npx create-knowledge-mcp my-mcp
cd my-mcp
npm run dev                                                   # http://localhost:8080/mcp, reloads on save
```

The generator ends with a guided setup. It asks which services to connect, checks each key against the real
service as you enter it, writes `.env` and `mcp.config.json`, creates the admin key and offers to add the server
to Claude Code. Nothing is edited by hand, and you can run it again any time:

```bash
npm run setup
```

Or let an AI agent do it. The project includes [`AGENTS.md`](packages/create-knowledge-mcp/template/AGENTS.md), a setup
guide for agents: open the folder in Claude Code and say "set this server up, follow AGENTS.md". The agent runs the
setup commands, asks before creating anything in your accounts, and never handles your secrets.

**Search your documents first.** A folder of documents is enough: no account and no key.

```bash
npm run setup -- folder ~/Documents/handbook   # Markdown, text, PDF, Word, PowerPoint, Excel
npm run dev
```

The server indexes the folder when it starts, and `search_knowledge` answers by keywords, in any language.
An embedding model adds search by meaning later, without reading the documents again. Google Drive documents
join the same index once Drive is connected.

The project comes with an example plugin, `src/plugins/notes.ts`. Point a client at
`http://localhost:8080/mcp` with `Authorization: Bearer <key>` and you will see `notes_add` and `notes_list`.

**Only the built-in connectors**

```bash
cp .env.example .env                         # fill in the connectors you want
cp mcp.config.example.json mcp.config.json   # Drive folders, excluded folders, sign-in allowlist
docker run -d --name kmcp -p 8080:8080 -v kmcp-data:/data --env-file .env \
  -v "$PWD/mcp.config.json:/app/mcp.config.json:ro" ghcr.io/chanthr/knowledge-mcp:latest
docker exec kmcp knowledge-mcp keys create --email you@example.com --role admin
docker exec kmcp knowledge-mcp doctor        # which connectors are on, and what each one is missing
```

[`.env.example`](.env.example) lists every variable. Each connector turns on when its variables are set.
The image holds no config: mount `mcp.config.json` as above, or pass it inline with `-e MCP_CONFIG_JSON='{…}'`.
[`compose.yaml`](compose.yaml) does the same with Docker Compose.

## The console

A page in your browser for everything the setup commands do. Start the server in a terminal and it prints the
address:

```bash
npx @chnxthr/knowledge-mcp     # in any folder: the settings are saved there, and the console opens
npm run dev                    # in a generated project: the address is in the first lines
```

![The console: what is connected and whether it works](.github/assets/console-overview.png)

| Page | What you do there |
| --- | --- |
| Documents | Drop files or folders on the page, add a folder by its path, connect Google Drive (sign in with Google, let gcloud make a service account, or paste a key), turn on search by meaning. Pick the embedding model from what your endpoint has (a local Ollama, OpenAI, any compatible one), and change it later: new vectors are made from the stored text, with the progress on the page |
| Graph | How your documents point at each other: the links people wrote, with the most linked documents, a view around any one document, and the loose ends (links to nowhere, documents nothing links to) |
| Databases and APIs | Connect Postgres, SQLite or an HTTP API. Write a query once and save it as a tool: the page lists the tables and checks the query on the real database before it is saved |
| Apps | Connect Slack, GitHub and Railway: by signing in where the app allows it, or with a token. Add apps that have an MCP server of their own (Notion, Supabase, Linear, Sentry, …): you sign in at the app, and its read tools arrive under its name |
| Tools | Every tool an AI client can call. Fill in the form and run one to see what the client gets back |
| Connect a client | One button adds this server to Claude Code, Claude Desktop, Cursor or VS Code, and shows which already have it. The entry is there to copy as well |
| People and keys | Create and revoke keys, and limit a person to some tools |
| Activity | The latest tool calls: who, when, how long, and whether it worked |

![The console: trying a tool](.github/assets/console-tools.png)

A saved change takes effect by itself: the server starts again and the page waits for it. Every value is checked
against the real service before it is written, to the same `.env` and `mcp.config.json` the commands write, so the
console and the commands can be mixed freely.

### Connecting without copying a token

Making a token in another site's settings and carrying it over is the slow part of setting up. Where a service
offers something better, the console uses it:

| Service | In the console | What it takes |
| --- | --- | --- |
| Railway | **Sign in with Railway** | Nothing to prepare. The server registers itself with Railway, you sign in and pick the workspaces it may read, as a viewer. The sign-in renews itself |
| Google Drive | **Sign in with Google** | An OAuth client of your own Google Cloud project, made once: client ID and secret go into the form. The server then reads your My Drive, or the folders you list, as you. Google reviews every shared app that reads Drive, which is why there is no ready-made one to offer |
| Google Drive | **Account with gcloud** | The gcloud CLI, signed in. It creates a service account and its key; you then share folders with that account |
| Notion, Supabase, Linear and other apps with an MCP server | **Add an app** | Nothing to prepare where the app's server follows MCP's sign-in rules: this server registers itself there and you sign in at the app. Only its tools that read are turned on, and Supabase is added in its read-only mode |
| GitHub | **Use the gh login** | The gh CLI, signed in |
| Slack | A link that opens Slack's "Create an app" with the read-only permissions filled in | The bot token is still copied once. Slack's sign-in needs a secret and a public https address, which a server on your machine has not |

A token can still be pasted for each, and `RAILWAY_TOKEN` in the environment wins over a sign-in. With a personal
Google account, publish the OAuth consent screen (it stays unverified, which is fine for your own use): left in
"Testing", Google ends the sign-in every 7 days.

The console is for the person at the machine. It is served only when the server was started in a terminal (a
service, a container or a process manager gets none unless `KNOWLEDGE_CONSOLE=on`), it answers only a browser on
this machine that asks for `localhost`, and its API needs a token the server creates on first start
(`<data dir>/console-token`) and prints as part of the address. The page never shows a secret: it says that a
token is set, not what it is. Whoever holds the console token is the admin of this server, so keep it like a
password. `KNOWLEDGE_CONSOLE=off` turns the console off.

## How it works

<p align="center">
  <img alt="How it works: Create, Add a tool, Authorize, Use" src=".github/assets/flow.svg" width="100%">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/parts-dark.svg">
  <img alt="Parts: core (built in), plugins (you write one file each), gateway (config only), store (built in)" src=".github/assets/parts-light.svg" width="100%">
</picture>

<details>
<summary>The same as a table</summary>
<br>

| Part | What it does | You write it? |
| --- | --- | --- |
| Core | HTTP and stdio transports, API keys, OAuth 2.1 with Google sign-in, roles, audit log, secret masking in logs | No |
| Plugins | One connector each: its tools, the env vars it needs, its permission group | Yes, one file per plugin |
| Gateway | Proxies other MCP servers (GitHub's, Notion's, yours) under a name prefix, read-only by default | Config only |
| Store | Keys, users, OAuth tokens, plugin state, audit log. SQLite file by default, Supabase optional | No |

</details>

<details>
<summary>What happens on each request</summary>
<br>

| Step | Who | What happens |
| :---: | --- | --- |
| 1 | Client | Calls `/mcp` with `Authorization: Bearer <API key or OAuth access token>`. |
| 2 | Core | Checks the key against its stored hash, or verifies the OAuth token, then loads the person's role and limits. |
| 3 | Core | Lists only tools whose plugin is configured and that the person's role allows. |
| 4 | Plugin | Gets validated input and the caller, does the work, returns text or JSON. The call is logged. |

</details>

## Add a tool

Every file in `src/plugins/` is a plugin. Copy the example and edit it:

```ts
// src/plugins/weather.ts
import { definePlugin, defineTool, ToolError, z } from '@chnxthr/knowledge-mcp';

export default definePlugin({
  id: 'weather',                    // also the permission group
  env: ['WEATHER_API_KEY'],         // the tools stay hidden until this is set
  tools: [
    defineTool({
      name: 'weather_now',
      description: 'Current weather for a city. Use it for questions about today’s weather.',
      input: z.object({ city: z.string().describe('City name, e.g. Seoul') }),
      annotations: { readOnlyHint: true },
      run: async ({ city }, ctx) => {
        const r = await fetch(`https://api.example.com/weather?q=${encodeURIComponent(city)}`, {
          headers: { Authorization: `Bearer ${process.env.WEATHER_API_KEY}` },
        });
        if (r.status === 404) throw new ToolError(`No city named ${city}`);
        ctx.log(`weather for ${city} by ${ctx.user.email}`);
        return r.json();            // any JSON value is sent as compact JSON
      },
    }),
  ],
});
```

Save the file and the dev server restarts. New files in `src/plugins/` are picked up too. You did not touch a
router, a tool list or a permission table.

| The core does this for you | How |
| --- | --- |
| Lists the tool | From `name`, `description` and the zod `input` (zod 3 or 4), turned into JSON Schema |
| Hides it when not configured | Until every name in `env` is set, and `enabled()` returns true when you add one |
| Validates input | Bad input returns `[invalid_input] tool '<name>': field: reason` to the model, and `run` is not called |
| Checks permission | The plugin `id` is the permission group (see [Access control](#access-control)) |
| Formats the result | A string becomes text, any other value becomes compact JSON (the reader is a model, and indentation is a third of an indented answer), an MCP result passes through |
| Handles errors | `throw new ToolError('...')` returns `[error] ...`. Any other error returns `[fatal] ...` |
| Logs the call | Tool, person, role, success and duration go to the audit log. Arguments are not stored |

## Your data as tools

A database or an internal API becomes tools without a plugin file. Name the connection, then declare what may be
asked of it. Both go in `mcp.config.json`; secrets stay in `.env`.

```json
{
  "connections": {
    "shop": { "type": "postgres", "urlEnv": "SHOP_DATABASE_URL", "description": "Orders and customers" },
    "crm": { "type": "http", "baseUrl": "https://crm.example.com/api/v2", "headers": { "Authorization": "Bearer ${CRM_TOKEN}" } }
  },
  "tools": [
    {
      "name": "orders_by_customer",
      "connection": "shop",
      "description": "Orders of one customer, newest first. Use it for questions about what a customer bought.",
      "params": {
        "email": { "type": "string", "description": "Customer email" },
        "limit": { "type": "integer", "default": 20, "min": 1, "max": 100 }
      },
      "sql": "select id, total, status, created_at from orders where email = :email order by created_at desc limit :limit"
    },
    {
      "name": "crm_contact",
      "connection": "crm",
      "description": "One CRM contact by id.",
      "params": { "id": { "type": "string" } },
      "request": { "path": "/contacts/{id}", "pick": "data" }
    }
  ]
}
```

```bash
npm run setup -- connection shop --postgres --env SHOP_DATABASE_URL   # writes the connection
npm run setup -- secret SHOP_DATABASE_URL                             # you type the URL into .env, unseen
npm run setup -- check                                                # connects, and compiles every query
```

`setup check` connects to each database and compiles each declared query there, so a misspelled column is reported
before the model ever calls the tool. Nothing is executed. The config is read at startup; `npm run dev` restarts
when `mcp.config.json` or `.env` changes.

**Or let the assistant write the queries.** With `"explore": true` on a database connection two more tools appear:
`shop_tables` lists the tables and columns, `shop_query` runs one read-only SELECT. The assistant can then answer
questions nobody prepared a tool for. `npm run setup` offers this when you pick Database.

| What keeps it safe | How |
| --- | --- |
| A value is never part of the SQL | Each `:name` is bound by the database driver. Whatever the caller passes is data |
| A read-only tool cannot write | Postgres: the query runs alone in a read-only transaction that is rolled back, and the server accepts one statement. SQLite: the file is opened read-only. Both refuse a write however the query is written |
| One question cannot take a table or the server | The row limit (`maxRows`, default 100) is applied by the database and the time limit (`timeoutMs`, default 10 s) stops the query. An answer is limited in size too: long values are cut at 4,000 characters, a Postgres result over 16 MB is dropped, and at most 4 SQLite queries run at once |
| An API tool stays on its API | A parameter fills one path segment, a query value, a header value or a JSON field. The host and base path are fixed, and redirects are not followed |
| A secret stays a secret | `${ENV_NAME}` values are masked wherever they show up in an answer, such as an API error that echoes the request. A parameter cannot pull one in: a value is never read as a template |
| Who may call it | The connection's name is a permission group like a plugin id (see [Access control](#access-control)). A member without a tool list may use every group, a new connection included |
| What it can read | Whatever the database user can read, above all with `explore`. Give the connection a user of its own that can only read, and only what everyone using this server may see. Never a superuser, and not the user your application runs as: a query can end other sessions of its own user |

<details>
<summary>Connections, tools and parameters in full</summary>
<br>

| Connection | Fields |
| --- | --- |
| `postgres` | `urlEnv` (the NAME of the env var holding `postgres://user:password@host:5432/db`), `explore`, `maxRows`, `timeoutMs`, `pool` (connections kept open, default 3), `description` |
| `sqlite` | `path` (absolute, or relative to the project), `explore`, `maxRows`, `timeoutMs`, `description`. Each query runs in a short-lived child process, so a slow one can be stopped, and it ends with the server instead of outliving it |
| `http` | `baseUrl`, `headers` and `query` sent with every request (a value may contain `${ENV_NAME}`), `timeoutMs` (default 15 s), `maxBytes` (largest response read, default 1 MB), `description` |

| Tool field | Meaning |
| --- | --- |
| `name`, `description` | What the model sees. It picks tools by the description, so say what the tool answers and when to use it |
| `connection` | The connection it runs on |
| `params` | `{ name: { type, description, required, default, enum, min, max, maxLength, pattern } }`. `type` is `string`, `integer`, `number` or `boolean`. A parameter with a `default` is optional; an optional one without a value is NULL in SQL and left out of a request |
| `sql` | One statement with `:name` where a parameter goes (database connections) |
| `request` | `{ method, path, query, headers, body, pick }` (http connections). `{name}` puts a parameter in. In `body`, a string that is exactly `{name}` takes the parameter's own type. `pick` keeps one part of a JSON answer, such as `data.items` |
| `readOnly` | SQL: default `true`; set `false` for a tool that is meant to change data. HTTP: default `true` for GET; any other method has to say `true` or `false` |
| `maxRows`, `timeoutMs` | Override the connection's limits for this tool |

| Command | What it does |
| --- | --- |
| `knowledge-mcp setup connection <name> --postgres --env NAME [--explore]` | Add a Postgres connection. The connection string is never an argument |
| `knowledge-mcp setup connection <name> --sqlite <file> [--explore]` | Add a SQLite file |
| `knowledge-mcp setup connection <name> --http <base URL> --header 'Authorization: Bearer ${API_TOKEN}'` | Add an API. A header or query value that looks like a secret must be written as `${ENV_NAME}` |
| `knowledge-mcp setup secret <ENV_NAME>` | Type one secret into `.env` without it being shown (needs a terminal) |
| `knowledge-mcp <name> tables [filter]` | The tables and columns the connection can read, for writing tools |
| `knowledge-mcp <name> check` | Check one connection and its tools |

A mistake inside the config (a parameter the query does not use, a second statement, an unknown connection) stops
the server at boot with the tool's name in the message. Postgres uses the [`pg`](https://node-postgres.com) driver,
loaded on first use.

</details>

## Plugin API

Everything is exported from `@chnxthr/knowledge-mcp`.

<details open>
<summary><code>definePlugin({...})</code></summary>
<br>

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Lowercase letters, digits and dashes. Permission group and config key |
| `description` | `string` | One line shown by `knowledge-mcp doctor` |
| `env` | `string[]` | Env vars that must all be set for the plugin to turn on |
| `enabled` | `() => true \| string` | Extra condition. Return a reason string to stay off; `doctor` shows it |
| `tools` | `Tool[]` | Tools made with `defineTool` |
| `upstreams` | `UpstreamSpec[]` or a function | Remote MCP servers whose tools join this plugin's group (see [Gateway](#remote-mcp-servers)) |
| `instructions` | `string` | Usage notes added to what the client receives on connect |
| `configSchema` | zod schema | Validates `plugins.<id>` in `mcp.config.json`; the result is `ctx.config` |
| `start` | `(ctx) => void` | Runs once after the HTTP server listens. For background jobs. Not run in stdio mode |
| `commands` | `{ [name]: { description, run(args) } }` | CLI commands: `knowledge-mcp <id> <name> [args]` |

</details>

<details open>
<summary><code>defineTool({...})</code> and the context</summary>
<br>

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Lowercase letters, digits and underscores. Unique across all plugins; `ping` is reserved |
| `description` | `string` | What it does and when to use it. The model picks tools by this |
| `input` | zod object | Arguments. Describe each field with `.describe()`. Omit for no arguments |
| `annotations` | `ToolAnnotations` | MCP hints such as `readOnlyHint` and `destructiveHint` |
| `enabled` | `() => true \| string` | Extra condition for this one tool |
| `run` | `(input, ctx) => value` | Gets the parsed input and the context below |

| `ctx.` | Meaning |
| --- | --- |
| `user` | `{ email, role, keyId }`. Role is `admin`, `member` or `viewer` |
| `state` | `get(key)`, `set(key, value)`, `delete(key)`. Kept per plugin in the store, so it survives restarts |
| `config` | This plugin's `plugins.<id>` section of `mcp.config.json` |
| `log(...)` | Writes to stderr with the plugin name. Secrets are masked. Never use `console.log` in stdio mode |
| `auth` | The full auth context, including Slack channel and Drive folder limits |

</details>

<details>
<summary>Your <code>server.ts</code> and loading plugins</summary>
<br>

A generated project has one entry file. It is also the command line, so every command sees your plugins.

```ts
import { run, builtinPlugins, loadPlugins } from '@chnxthr/knowledge-mcp';

const mine = await loadPlugins(new URL('./plugins/', import.meta.url));
await run({ plugins: [...builtinPlugins, ...mine] });
```

`loadPlugins` imports every `.ts` and `.js` file in the folder in name order. It skips names starting with `_`,
`.d.ts` files and tests. Leave out `builtinPlugins`, or pick from `knowledgePlugin`, `drivePlugin`, `slackPlugin`, `githubPlugin`
and `railwayPlugin`, to ship fewer connectors.

</details>

## CLI

The `knowledge-mcp` binary, the Docker image entrypoint, and your own `server.ts` all take these commands.

| Command | What it does |
| --- | --- |
| `setup` | Guided setup: connect Drive, Slack, GitHub and Railway, check every value live, write `.env` and the config, create the admin key. With gcloud installed it creates the Drive service account for you; with gh signed in it can reuse that login. Safe to run again |
| `setup check` | Verifies every configured service against the real thing. Exit code 1 on a failure |
| `setup drive --gcloud [--project ID] [--yes]` | Creates the Drive service account and key with the gcloud CLI. Prints its plan and creates nothing without `--yes` |
| `setup trust <email-or-domain>...` | Adds owners whose shared Drive documents are shown |
| `setup folder <path>` | Adds a local folder of documents to the search index |
| `setup connection <name> --postgres --env NAME` / `--sqlite <file>` / `--http <base URL>` | Adds a database or an API for tools declared in the config (see [Your data as tools](#your-data-as-tools)) |
| `setup secret <ENV_NAME>` | Types one secret into `.env` without it being shown |
| `setup drive --key <file>` / `setup github --from-gh` / `setup embeddings --base-url URL --model NAME` | Setup steps that ask nothing, for scripts and AI agents |
| `serve` | Starts the HTTP server on `$PORT` (default 8080). Started in a terminal it also serves [the console](#the-console) at `/console/` and restarts itself when the console saves a change; `--open` opens the console in the browser, and so does running with no command at all. `serve --stdio` talks over stdin and stdout instead |
| `keys create [--email E] [--role R] [--label L] [--expires 90d]` | Creates an API key and prints it once. Only its hash is stored |
| `keys list` / `keys revoke <id>` | Lists keys (never the key itself) or deactivates one |
| `users add <email> [--role admin\|member] [--tools a,b]` | Registers a person. `--tools` limits a member to those plugins |
| `users list` / `users remove <email>` | Shows or removes people |
| `doctor` | Config source, store, OAuth, and each plugin on or off with the reason |
| `<plugin> <command>` | A plugin command, e.g. `drive reindex --dry-run`, `slack channels`, or for a connection `shop tables` |

## Built-in plugins

Each turns on when its env vars are set. All built-in tools only read.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/plugins-dark.svg">
  <img alt="Built-in plugins: Knowledge, Google Drive, Slack, GitHub and Railway" src=".github/assets/plugins-light.svg" width="100%">
</picture>

<details>
<summary>Tools and what each plugin needs</summary>
<br>

| Plugin | Tools | Needs |
| --- | --- | --- |
| `knowledge` | `search_knowledge`, `read_document`, `linked_documents` | A local folder (`folders` in the config) or Google Drive. Nothing else: the index is a local file and search works by keywords. An embedding model (`OPENAI_API_KEY`, or another provider through `EMBEDDING_BASE_URL`) adds search by meaning. With `QDRANT_URL` vectors live in Qdrant and an embedding model is required |
| `drive` | `search_drive`, `read_drive_file`, `list_drive_folder` | A Google sign-in from the console (it reads your own Drive), or a service account: share a folder or a document with that account and it is searchable. An OAuth refresh token in the environment works too |
| `slack` | `slack_list_channels`, `slack_read_channel`, `slack_find_files`, `slack_get_file` | `SLACK_BOT_TOKEN` (`xoxb-`). The bot sees only channels it was invited to |
| `slack` | `slack_search` | `SLACK_USER_TOKEN` (`xoxp-`) as well. Results are limited to the bot's channels |
| `github` | `repo_tree`, plus GitHub's remote MCP tools as `github_*` (read-only) | `GITHUB_PAT` (or `GITHUB_TOKEN`) with Contents: read |
| `railway` | `railway_services`, `railway_deployments`, `railway_logs` (secrets in logs are masked) | A sign-in from the console, or `RAILWAY_TOKEN`. A sign-in asks for viewer access: it lists projects and deployments, and Railway does not show it logs. Logs need a token |
| core | `ping` | Nothing. Shows who you are and which plugins are on |

</details>

<details>
<summary>The search index</summary>
<br>

`search_knowledge` searches one index that every source feeds. It needs nothing but a source.

| Search mode | When | What it finds |
| --- | --- | --- |
| Keywords | Always, with nothing configured | Documents that contain the words of the question. Korean, Japanese and Chinese are matched by character pairs, so a word is found with any ending attached |
| Keywords + meaning | An embedding model is set (`OPENAI_API_KEY`, or `EMBEDDING_BASE_URL` for another provider or a local model) | Also documents that say the same thing in other words. The two result lists are merged by rank. When the embedding endpoint is down, search answers from keywords and says so |
| Meaning only | `QDRANT_URL` is set | Vectors live in Qdrant, which holds no keyword index here. An embedding model is required |

What the model reads is kept short, because it pays for every line:

| Tool | What comes back |
| --- | --- |
| `search_knowledge` | Up to `topK` parts (default 5, at most 2 per document), each with the document, its date, an ID, the heading and how many terms of the question it holds. Two parts that are neighbours in a document are shown as one passage. When no passage holds half of the terms, the answer says the match is weak. A filter that matches nothing answers with the values that field has |
| `read_document` | With `part` (the number a result shows): that passage and the parts around it (`around`, default 1), a few thousand characters. Without it: the document from the start, up to `maxChars` (default 20,000), and the `offset` that continues it. Plain text, not JSON |
| `linked_documents` | With a document ID: what it links to and what links to it, by title, each with its ID. Without one: how many documents and links there are, and the documents most others link to. A search result that has links says so (`Links: to 2 · from 3`) |
| A tool on a database | Rows as a compact table: `{"rowCount":2,"columns":["id","total"],"rows":[[1,10.5],[2,20]]}`, one row per line. The column names are said once |

**The knowledge graph.** Documents in the local folders are linked the way their authors linked them, with no
model in between: `[[Note]]`, `[[Note|shown text]]` and `[[folder/Note#Heading]]` as Obsidian writes them,
Markdown links to documents (`[guide](../guides/setup.md)`), and header fields that name documents
(`related: [a.md, "[[Note]]"]`). So an Obsidian vault added as a folder brings its graph with it. A target finds
its document by path, by file name anywhere in the folder, or by title and alias; a note written later makes
yesterday's dangling link whole. Only links that plainly meant a document and match none are reported as broken.

| Task | How |
| --- | --- |
| Add a local folder | `knowledge-mcp setup folder <path>`, or `folders` in the config. The HTTP server scans it at start and every 10 minutes (`KNOWLEDGE_SCAN_INTERVAL_MIN`); a stdio session scans once when it starts; `knowledge-mcp knowledge scan` scans now. Unchanged files are not opened, deleted files leave the index. Text is indexed first and vectors afterwards, so keyword search covers the folder within seconds |
| Add Drive documents | Connect Drive. The server builds the first index when it starts with an empty one (`DRIVE_AUTO_INDEX=false` turns that off), then syncs changes every 30 minutes (`DRIVE_SYNC_INTERVAL_MIN`); a stdio session syncs once when it starts |
| Add search by meaning later | Set the embedding model and restart. Stored passages get their vectors on the next scan or sync; no document is read again |
| Change the embedding model | Set the new model, then `knowledge-mcp knowledge reembed`: it drops the old vectors and makes new ones from the stored text. Until then search answers by keywords, because vectors of two models are never mixed |
| What leaves the machine | Nothing for keyword search. With an embedding model, passage text and each question go to that model's endpoint |
| Where it lives | `<data dir>/vectors.db`: the text, the keyword index and the vectors. Measured with 90,000 passages (5,000 files): a keyword search takes about 6 ms, a search by meaning about 85 ms, and the vectors take about 4 bytes × dimensions per passage in memory (370 MB at 1,024 dimensions), read on the first search by meaning. Set `QDRANT_URL` (and reindex) for larger indexes or several servers |
| Scanned files | The automatic runs never use paid OCR. `knowledge-mcp drive reindex` adds scanned Drive files when Mathpix is configured; scanned files in local folders are left out |
| Clean up | A full `drive reindex` deletes Drive documents no longer listed, such as files moved into an excluded folder |
| Start over | `drive reindex --recreate` empties the index first, local folders included (they are indexed again by the next scan). `--dry-run` only counts passages and skips OCR |

A lock file keeps two processes on one data directory from indexing at the same time.

| Format | How text is extracted |
| --- | --- |
| Markdown, plain text | As is |
| Google Docs, Slides | Drive export |
| Google Sheets | Drive export, every tab as its own section |
| Word, PowerPoint, Excel, PDF with text | Local parsers |
| Scanned PDF, PNG, JPEG, WebP | Mathpix OCR, Drive only, when `MATHPIX_APP_ID` and `MATHPIX_APP_KEY` are set |

Files larger than `DRIVE_MAX_FILE_BYTES` (50 MB by default) are not read or indexed. In a local folder, dot files,
`node_modules`, the folder names in `drive.excludeFolders` and symbolic links are skipped, and at most 20,000 files
per folder are indexed (`KNOWLEDGE_MAX_FILES`). Embeddings use OpenAI `text-embedding-3-small` by default. Any
OpenAI-compatible `/embeddings` endpoint works: set `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_DIM`
(for example a local `bge-m3` behind Ollama).

</details>

<details>
<summary>Slack channel map</summary>
<br>

`slack_list_channels` tells the model what each channel is for.

1. Invite the bot to the channels it should read, then call `slack_list_channels` once from a client. That call
   copies the channel list from Slack into the map. New channels arrive switched off.
2. Describe a channel and switch it on: `knowledge-mcp slack channel '#dev' --purpose "Deploys and incidents" --on`.
   List the map with `knowledge-mcp slack channels`.

On and off only decide what `slack_list_channels` shows by default. They do not grant or block reading:
that depends on the bot's channels and on each person's allowed channels.

</details>

## Configuration

| Layer | Where | What |
| --- | --- | --- |
| Secrets | Env vars (`.env` locally, host env in production) | Keys and tokens. [`.env.example`](.env.example) lists them all |
| What to look at | `mcp.config.json` | Drive folders, exclusions, sign-in allowlist, viewer access, plugin settings, remote MCP servers. See [`mcp.config.example.json`](mcp.config.example.json) |

`.env` and `mcp.config.json` are read from the working directory first, then from your project folder, so a
client that starts the server from elsewhere still finds them. `MCP_CONFIG_JSON` (inline) and
`MCP_CONFIG_PATH` override the file. `MCP_HOME` names the folder of the settings and the data outright; the
working directory is then not looked at, which is what a client's entry needs when the server is started through
npx from somebody else's project. The config is read once at startup: restart the server after you change it, the
sign-in allowlist included. (A server started in a terminal restarts itself when the console saves a change.)

| Config key | Meaning |
| --- | --- |
| `orgId` | Organization identifier carried in the auth context |
| `branding.name` / `branding.instructions` | Name shown on the sign-in consent page and in OAuth metadata. `instructions` replaces the guide the client receives (base line plus each plugin's notes) |
| `folders[]` | `{ path, name, source }` local folders to index and search. `path` is absolute or relative to the config file. `name` (default: the folder's own name) shows in results and document ids; `source` (default `files`) is the label for the `source` search filter. env `KNOWLEDGE_FOLDERS` adds comma-separated paths |
| `drive.roots[]` | `{ id, name, source, metadata }` folders to index and search. `source` is a label you choose (`handbook`, `sales`, …; default `docs`) and becomes the `source` search filter. `metadata` is `path` (default: category, customer and tags from folder and file names) or `frontmatter` (Markdown with a YAML header) |
| `drive.scope` | `shared` (default): the roots plus any folder or document that a trusted owner (`drive.trustedOwners`) shared with the service account. `roots`: only files under `drive.roots`. env `DRIVE_SCOPE` overrides |
| `drive.trustedOwners[]` | Whose documents are shown when they are shared with the service account outside the roots: emails (`ann@acme.com`), domains (`acme.com`) or shared drives (`drive:<id>`). Empty by default, which shows nothing outside the roots. `knowledge-mcp setup` asks for it. env `DRIVE_TRUSTED_OWNERS` overrides |
| `drive.sharedSource` | `source` label for documents shared outside the roots. Default `shared` |
| `drive.excludeFolders[]` | Folder names skipped everywhere, in Drive and in local folders: index, search, read and list. Case and spacing are ignored |
| `drive.customerFolders[]` | Top-level folders (in `path` metadata sources) with one subfolder per customer (`Clients/Acme/…` → customer `Acme`), for the `customer` search filter. Default `Clients`, `Customers`, `고객사` |
| `drive.rank[]` | Optional `{ prefix, label, weight }` rules for `search_knowledge`, e.g. prefer `Current/` (weight 1.1) over `Archive/` (0.9). Default: none |
| `qdrant.collection` | Vector collection name (env `QDRANT_COLLECTION` overrides) |
| `oauth.allowedDomains[]` / `oauth.allowedEmails[]` | Who may sign in with Google |
| `access.viewerTools[]` | Plugin ids open to signed-in people without a users entry. Default: none |
| `plugins.<id>` | Settings for one plugin, passed as `ctx.config` |
| `upstreams[]` | Remote MCP servers (next section) |
| `connections.<name>` | A Postgres database, a SQLite file or an HTTP API. The name is the permission group. See [Your data as tools](#your-data-as-tools) |
| `tools[]` | Tools declared on a connection: one SQL query or one API request each, with typed parameters |
| `data.schema` | Supabase schema for the server's tables (Supabase store only) |

<details>
<summary>Store: SQLite or Supabase</summary>
<br>

| Store | When | Setup |
| --- | --- | --- |
| SQLite (default) | One server, one machine | Nothing. The file is `<data dir>/knowledge-mcp.db` (`MCP_DATA_DIR`, `/data` in Docker). Created owner-only (0600) |
| Supabase | State in a shared Postgres you can browse | Run [`sql/supabase.sql`](packages/knowledge-mcp/sql/supabase.sql) (again after every upgrade), set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` |

Setting both Supabase variables selects Supabase. `MCP_STORE=sqlite|supabase` forces one.

</details>

### Remote MCP servers

The server can also be a gateway: list another MCP server and its tools appear under a prefix, behind your
keys and permissions.

In the console this is **Apps → Add an app**: pick from the list (Notion, Supabase, Linear, Atlassian, Sentry,
Vercel, Stripe, Airtable, Figma and more) or give the address of any MCP server. When the server says where to
sign in and lets a client register itself, you are sent there to sign in; a token can be pasted where the
service gives one. By hand, in `mcp.config.json`:

```json
{
  "upstreams": [
    {
      "name": "notion",
      "url": "https://mcp.example.com/mcp",
      "tokenEnv": "NOTION_MCP_TOKEN",
      "expose": "read"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Permission group and log name |
| `prefix` | Tool name prefix. Default `<name>_` |
| `tokenEnv` | Env var holding the bearer token. The token never goes in the config file |
| `signIn` | `true`: use the sign-in made from the console (`<data dir>/mcp-logins/<name>.json`). The gateway renews it by itself. Not together with `tokenEnv` |
| `expose` | `"read"` (default) lists only tools that read: the ones the remote marks as read-only, and of those it does not mark, the ones whose first word is a read verb such as `get`, `list` or `search` (`notion-search` counts as `search`). A tool the remote marks as changing things stays hidden whatever its name. `"all"` lists everything. A list exposes exactly those remote tool names |

If a remote tool has the same name as a local one, the local tool wins and the remote one is hidden.

## Access control

**Who someone is** comes from an API key or a Google sign-in. **What they can use** comes from their users entry.

| Users entry | Role | What they can use |
| --- | --- | --- |
| `--role admin` | admin | Every tool |
| `--role member` | member | Every plugin, unless `--tools` lists the ones they may use. Drive folders and Slack channels can be limited too |
| No entry | viewer | Only `ping`, plus the plugins in `access.viewerTools` |

```bash
knowledge-mcp users add lee@example.com --role member --tools drive,notes
knowledge-mcp keys create --email lee@example.com --expires 90d
```

<details>
<summary>API keys</summary>
<br>

1. Keys look like `kmcp_…` and are stored only as SHA-256 hashes. The key is shown once.
2. A key with an email takes the person's role from their users entry, so removing the entry demotes the key.
   A key without an email is a service key with its own role.
3. `keys revoke <id>` takes effect within `AUTH_CACHE_TTL_MS` (60 seconds by default).
4. Failed authentication is rate-limited per client IP. Set `TRUST_PROXY` to match your proxy so the IP is real.
5. stdio runs as the local admin unless `MCP_API_KEY` is set, because whoever starts the process already
   holds every token in its env.

</details>

<details>
<summary>OAuth for Claude web and desktop connectors</summary>
<br>

Set the OAuth variables and an allowlist to turn on a built-in OAuth 2.1 server that signs people in with
Google. It shows a consent page naming the app and where the token goes before anything is issued. The full
guide is [`OAUTH_SETUP.md`](OAUTH_SETUP.md).

</details>

## Deploy

| What | How |
| --- | --- |
| Built-in connectors | `ghcr.io/chanthr/knowledge-mcp` (`latest` = newest release, `x.y.z`, `edge` = `main`). [`compose.yaml`](compose.yaml) runs it with a data volume |
| Your own project | `docker build` with the generated `Dockerfile`, then run it with a volume at `/data` |
| Railway | [`railway.toml`](railway.toml). Add a volume at `/data`, or set `MCP_STORE=supabase` |

1. **HTTPS.** Put the server behind HTTPS before remote clients connect. OAuth needs an `https` issuer.
2. **One replica.** Sessions and pending sign-ins live in memory, and SQLite is one file. Run a single instance.
3. **Keep `/data`.** Without a volume, keys and users are lost on redeploy.

## Connect a client

The console's **Connect a client** page does this for you: one button per client, with the entry made for your
folder and your server name. A desktop app does not have the PATH of your terminal, so the entry it writes names
Node by its full path and the server starts there too.

| Client | How |
| --- | --- |
| Claude Code, local | `claude mcp add my-mcp -- node /abs/path/my-mcp/dist/server.js serve --stdio` (run `npm run build` first) |
| Claude Code, local, without a project | `claude mcp add --scope user my-mcp -e MCP_HOME=/abs/path/folder -- npx -y @chnxthr/knowledge-mcp serve --stdio` |
| Claude Desktop, Cursor, VS Code, local | The same command and `MCP_HOME` in the client's config file, under `command`, `args` and `env` |
| Claude Code, remote | `claude mcp add --transport http my-mcp https://<host>/mcp --header "Authorization: Bearer <key>"` |
| Claude web and desktop | Turn on OAuth, then add a custom connector with `https://<host>/mcp` |
| Any MCP client | URL `https://<host>/mcp` with header `Authorization: Bearer <key>` |

## Upgrading from 0.3

| Change | What to do |
| --- | --- |
| Drive scope is `shared` by default | Documents that a trusted owner shared with the service account outside `drive.roots` can be searched, read and indexed. Nothing changes until you list owners in `drive.trustedOwners` (`knowledge-mcp setup trust acme.com`). Excluded folders stay hidden. `drive.scope: "roots"` turns it off |
| zod 4 | Plugins get zod 4 through the exported `z`. Change `z.record(valueSchema)` to `z.record(z.string(), valueSchema)`; an object `.default({})` that relies on inner defaults becomes `.prefault({})` |
| `source` is a free label | `dev` and `biz` keep working with their old meaning. `--dev-only` and `--biz-only` still work; the general form is `--source <label>` |
| Google Sheets are read tab by tab | Indexed sheets change on their next modification. Run `knowledge-mcp drive reindex` to refresh them all now |
| `semantic_search_drive` is now `search_knowledge` | It searches every source, by keywords with no embedding model. Its permission group is `knowledge`: add `knowledge` where a person's tools or `access.viewerTools` list `drive`. `read_document` reads a result by its Document ID |
| Search shows at most 2 passages per document | Set `KNOWLEDGE_MAX_PER_DOC` to change it |

## Upgrading from 0.2

| Change | What to do |
| --- | --- |
| Supabase is optional; SQLite is the default | Existing installs with `SUPABASE_*` set keep using Supabase. Rerun [`sql/supabase.sql`](packages/knowledge-mcp/sql/supabase.sql) once: it adds `mcp_plugin_state` and copies the Drive sync token |
| Commands moved into the CLI | `npm run reindex` → `knowledge-mcp drive reindex`. The image entrypoint is now `knowledge-mcp` (default `serve`) instead of `node dist/index.js` |
| Role `engineer` is now `member` | Existing rows keep working. `access.viewerTools` and `allowed_tools` take any plugin id |
| stdio without `MCP_API_KEY` | Runs as the local admin instead of refusing to start |
| Broken `mcp.config.json` | Now stops the server with the parse error instead of silently using defaults |

## Security notes

1. Never commit `.env`, service-account JSON, `mcp.config.json` or `data/`. All are gitignored and kept out of the image.
2. The data file holds key hashes and OAuth client secrets. It is created owner-only; keep the volume private.
3. Built-in plugins never change Drive, Slack, GitHub or Railway. The gateway exposes remote write tools only if you set `expose`.
4. Drive indexing sends document text to the embedding provider (OpenAI by default; your own server when `EMBEDDING_BASE_URL` is set), and scanned files to Mathpix when OCR is on.
5. Anyone who knows the service account's address can share a document with it; Drive asks nobody. So a document shared outside the roots is shown only when the top shared item belongs to an owner in `drive.trustedOwners`. Keep that list to your own organization, never `*`. What a trusted owner shares is visible to every user who may use the `drive` tools: list sensitive folder names in `drive.excludeFolders`.
6. A token reaches whatever it can read. Scope the Slack bot, the GitHub token and the Railway token to what every user may see.
7. A database connection reads whatever its database user can read. Give it a user of its own that can only read: never a superuser, not the user your application runs as, and with `explore` only one that sees what every permitted person may see. A member without a tool list may use every connection.

8. The console changes settings and runs tools as the admin, so it is kept to the person at the machine. It exists only when the server was started in a terminal or with `KNOWLEDGE_CONSOLE=on`. Requests from another address, with a forwarding header, under a host name other than `localhost`, or marked by the browser as coming from another site are refused; the API needs the console token; the page loads nothing from outside the server. Two limits to know: a reverse proxy on the same machine that adds no forwarding header (nginx's plain `proxy_pass`) looks like a local browser, so on a server leave the console off; and every user of a shared machine can reach `localhost`, where the owner-only token file is what keeps them out.
9. The console token is the admin's key. Its holder can change every setting, and can declare a connection that sends a secret from `.env` to an address of their choosing (that is what a connection is). The console narrows this to secrets in the folder's `.env`: it refuses a `${NAME}` that names one of the server's own credentials or a variable the server only inherited from the shell.
10. A sign-in made from the console is kept in the data directory (`railway-login.json`, `google-login.json`, `mcp-logins/`), readable by the owner only, like the data file. A Google sign-in reads as you: whatever is in the folders you chose is visible to every user of the server, so choose folders meant for all of them. The address the browser comes back to after a sign-in accepts only the answer to a sign-in the console started minutes before, and saves nothing by itself.
11. An app added through its MCP server acts as the account that signed in, for every user who may use that app's tools here. Only tools that read are on unless you allow changes, and what counts as reading is the app's own word about each tool, so add servers you trust. What its tools return is the app's text, not instructions.

## File map

| Path | Contents |
| --- | --- |
| [`packages/knowledge-mcp/src/plugin/`](packages/knowledge-mcp/src/plugin/) | Plugin API: `definePlugin`, `defineTool`, registry, loader, result formatting |
| [`packages/knowledge-mcp/src/core/`](packages/knowledge-mcp/src/core/) | Auth, OAuth, permissions, config, gateway, log masking |
| [`packages/knowledge-mcp/src/server/`](packages/knowledge-mcp/src/server/) | HTTP and stdio transports, MCP request handling, identity |
| [`packages/knowledge-mcp/src/store/`](packages/knowledge-mcp/src/store/) | Store interface, SQLite and Supabase implementations |
| [`packages/knowledge-mcp/src/plugins/`](packages/knowledge-mcp/src/plugins/) | Built-in plugins: `knowledge`, `drive`, `slack`, `github`, `railway` |
| [`packages/knowledge-mcp/src/connections/`](packages/knowledge-mcp/src/connections/) | Tools declared in the config: Postgres, SQLite and HTTP connections |
| [`packages/knowledge-mcp/src/admin/`](packages/knowledge-mcp/src/admin/) | The console's API, its access rules, and the supervisor that restarts the server after a saved change |
| [`packages/knowledge-mcp/console/`](packages/knowledge-mcp/console/) | The console page (React). Built into `dist/console-ui`; its controls are [affectUI](https://github.com/flohoeller/affectui) components, copied under `src/ui` (MIT, see the notice there) |
| [`packages/knowledge-mcp/src/run.ts`](packages/knowledge-mcp/src/run.ts) | The command line |
| [`packages/knowledge-mcp/test/`](packages/knowledge-mcp/test/) | Unit tests and end-to-end tests over HTTP and stdio |
| [`packages/create-knowledge-mcp/`](packages/create-knowledge-mcp/) | The generator and its project template |
| [`scripts/smoke-create.sh`](scripts/smoke-create.sh) | Pack, scaffold, install, build, serve and call, end to end |
| [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml), [`railway.toml`](railway.toml) | Image, local stack, Railway |
| [`.github/`](.github/) | CI, image and npm workflows, issue and PR templates, README images (`assets/make.py`) |

Develop with `npm install`, `npm test` (unit and end-to-end), `npm run typecheck` and `npm run smoke:create`.

## Contributing

Please open an issue for problems and ideas. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup, the checks to run and how to add a plugin. Changes per version are in [`CHANGELOG.md`](CHANGELOG.md).

| Template | Use it when |
| --- | --- |
| [**Bug report**](https://github.com/chanthr/internal-mcp/issues/new?template=01-bug.yml) | Something behaves differently from the code or the docs |
| [**Improvement**](https://github.com/chanthr/internal-mcp/issues/new?template=02-improvement.yml) | You have a better way, or a doc no longer matches the code |

This repository is public. Leave API keys, tokens, internal URLs and private documents out of issues and
pull requests. Report security problems privately with
[**Report a vulnerability**](https://github.com/chanthr/internal-mcp/security/advisories/new) on the Security tab, not in an issue.

## License

[MIT](LICENSE) © chanthr
