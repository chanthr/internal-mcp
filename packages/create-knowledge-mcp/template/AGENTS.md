# Setup guide for AI agents

You are helping a person set up this Knowledge MCP server. They want to use it, not configure it. Do the setup
for them with the commands below, and stop only where a person has to act (a browser sign-in, a secret only
they hold, a choice about their cloud account).

All commands run in this folder. `npm run setup -- <args>` passes arguments to the setup command.

## Rules

1. **Never ask the person to paste a secret into the chat, and never put one on a command line.** Tokens and keys
   reach `.env` through the setup commands, or the person types them into `npm run setup` in their own terminal
   or into the console in their browser (`npm run dev` prints its address).
2. **Never print a secret.** Do not `cat .env` or a key file. To see what is configured, run `npm run setup -- check`.
3. **Ask before anything is created in their accounts, and before trusting a document owner.** `setup drive --gcloud` prints its plan first and creates
   nothing without `--yes`. Show the plan, wait for a yes, then add `--yes`.
4. **Do not edit `.env` or `mcp.config.json` by hand for credentials.** Use the commands. Editing
   `mcp.config.json` for non-secret settings (excluded folder names) is fine.
5. After every step, run `npm run setup -- check` and report what it says.

## Step 1: see where things stand

```bash
npm run setup -- check
```

Each line is one service: `✓` works, `✗` is configured but failing (the message says why), `·` is not configured.
Ask the person which services they want. They do not need all of them.

## Step 2: documents on this machine (fastest)

If the person has a folder of documents (Markdown, text, PDF, Word, PowerPoint, Excel), this alone gives them
search. It needs no account and no key.

```bash
npm run setup -- folder /absolute/path/to/folder      # optional: --name handbook --source handbook
npm run knowledge -- scan                              # index it now (the server also does this when it starts)
```

Ask which folder. Do not pick one yourself, and do not add a home directory or a whole disk: everything under the
folder becomes searchable by everyone who can call the server. Search works by keywords. Step 4 adds search by
meaning.

## Step 3: Google Drive

This needs the gcloud CLI and a Google Cloud project.

```bash
gcloud --version                 # installed?
gcloud auth list                 # signed in?
gcloud projects list             # which projects exist
```

| Situation | What to do |
| --- | --- |
| gcloud is missing | Install it by following https://cloud.google.com/sdk/docs/install for their system. Ask before installing |
| Not signed in | The person runs `gcloud auth login` in their own terminal. It opens a browser. You cannot do this for them |
| No project | Ask which name to use, then `gcloud projects create <id>` |
| Signed in, project known | Continue below |

Show the plan (creates nothing):

```bash
npm run setup -- drive --gcloud --project <project-id>
```

Read the output to the person: which account, which project, the three commands, and that the service account
gets no project role. When they agree:

```bash
npm run setup -- drive --gcloud --project <project-id> --yes
```

This enables the Drive API, creates a read-only service account, saves its key to
`drive-service-account.json` (git-ignored) and writes the path to `.env`.

Then tell the person the service account address from the output and ask them to **share the Drive folders or
documents they want searchable with that address, as Viewer**. Nothing is visible until they do. Keyword search
and reading see a shared item at once; search by meaning sees it after the next sync (within 30 minutes, or when
a new session starts). Run `npm run setup -- check` to confirm: it shows how many items are shared.

### Whose documents are shown

Anyone who knows the service account's address can share a document with it. So a shared document is shown only
when its owner is trusted. `setup drive --gcloud --yes` trusts the Google account that ran it. `setup check` lists
items that are hidden and who owns them.

**Ask the person which of those owners are theirs. Never add an owner on your own judgment**: an unfamiliar owner
may be someone planting a document.

```bash
npm run setup -- trust acme.com            # a whole organization's domain
npm run setup -- trust ann@gmail.com       # one address (a public mail domain as a whole is refused)
```

Restart the server after changing the list.

If the person already has a key file: `npm run setup -- drive --key /path/to/key.json`.

| Error | Meaning | What to do |
| --- | --- | --- |
| organization blocks service account keys | An org policy forbids key creation | The person asks their Google Workspace admin to allow it for that project, or uses a project outside the organization |
| no billing account | The project cannot enable APIs | Pick another project, or the person links billing |
| lacks permission | Their account cannot manage that project | Pick a project they own |
| needs a fresh sign-in | The gcloud login expired | The person runs `gcloud auth login` again |

## Step 4: search by meaning (optional)

Search already works by keywords. An embedding model also finds documents that use other words than the question.
It can be added at any time: passages that are already indexed get their vectors without the documents being read
again. With a model set, passage text is sent to that model's endpoint; say so before turning it on.

| The person has | What to do |
| --- | --- |
| A local model server (Ollama, LM Studio) | `npm run setup -- embeddings --base-url http://localhost:11434/v1 --model bge-m3`. The vector size is detected |
| An OpenAI API key | They run `npm run setup` in their terminal and enter the key at the "Search by meaning" question |
| Neither | Skip it. It can be added later |

After changing to another model, run `npm run knowledge -- reembed`. It makes new vectors from the stored text.

## Step 5: a database or an internal API (optional)

The person's own data becomes tools from a few lines in `mcp.config.json`. The full reference is in the README of
`@chnxthr/knowledge-mcp`, section "Your data as tools".

```bash
npm run setup -- connection shop --postgres --env SHOP_DATABASE_URL     # or: --sqlite <file>, --http <base URL>
npm run mcp -- shop tables                                              # the tables and columns it can read
npm run setup -- check                                                  # connects, and compiles every declared query
```

| Rule | Why |
| --- | --- |
| Never ask for the connection string or an API token | The person runs `npm run setup -- secret SHOP_DATABASE_URL` in their own terminal and types it there, unseen. A command of yours never carries a secret |
| Ask which database user it is | It should be a user made for this server that can only read, and only what everyone using this server may see. Never a superuser, and not the user their application runs as |
| Ask before adding `--explore` | It lets the assistant run any read-only query. Say that it reads whatever the database user can read |
| Ask before any tool with `"readOnly": false` | Such a tool changes data. Say what it changes and wait for a yes |
| For an API, write secrets as `${ENV_NAME}` | `--header 'Authorization: Bearer ${CRM_TOKEN}'`. The command refuses a secret written out |

To add a tool, look at the tables, then edit `tools` in `mcp.config.json` (this file has no secrets, so you may
edit it):

```json
{
  "tools": [
    {
      "name": "orders_by_customer",
      "connection": "shop",
      "description": "Orders of one customer, newest first. Use it for questions about what a customer bought.",
      "params": { "email": { "type": "string", "description": "Customer email" }, "limit": { "type": "integer", "default": 20, "min": 1, "max": 100 } },
      "sql": "select id, total, status, created_at from orders where email = :email order by created_at desc limit :limit"
    }
  ]
}
```

Write `:name` where a value goes and declare every name in `params`. Never build SQL by putting a value into the
text. One statement per tool. Run `npm run setup -- check` after every change: it reports a misspelled column or an
undeclared parameter with the tool's name, and the server does not start while the file has such a mistake.

## Step 6: GitHub (optional)

```bash
gh auth status                   # signed in?
npm run setup -- github --from-gh
```

This reuses the gh CLI login. Tell the person that this token can do everything their gh login can, and that a
fine-grained read-only token is safer for a server other people use. If they prefer that, or gh is not signed
in, they run `npm run setup` in their terminal and enter a token there.

## Step 7: Slack and Railway (optional)

These need a token the person creates in a web console, so they run `npm run setup` in their own terminal and
pick the service. The wizard says where to get the token and checks it as they enter it. The page **Apps** of
the console (`npm run dev` prints its address) takes the same token and checks it the same way.

| Service | Where the token comes from |
| --- | --- |
| Slack | api.slack.com/apps → their app → OAuth & Permissions → Bot User OAuth Token (`xoxb-`). Scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:history`, `mpim:history`, `users:read`, `files:read`. Message search also needs a user token (`xoxp-`) with `search:read` |
| Railway | railway.com → Account Settings → Tokens |

## Step 8: keep sensitive folders out (optional)

Ask whether any folders, in Drive or on this machine, must stay out of search (HR, contracts, personal data). Put the folder names in
`mcp.config.json`. This file has no secrets and you may edit it:

```json
{ "drive": { "excludeFolders": ["HR", "Contracts"] } }
```

## Step 9: connect and verify

```bash
npm run setup -- check           # every configured line should be ✓
npm run doctor                   # which tools are on
```

Connect it to the person's AI client. For Claude Code on this machine, no key is needed:

```bash
claude mcp add __NAME__ -- "$PWD/node_modules/.bin/tsx" "$PWD/src/server.ts" serve --stdio
```

The console's page **Connect a client** has the entry for Claude Desktop, Cursor and VS Code as well.

For other people or remote clients, start the server with `npm run dev` and create a key. The key is printed
once, so have the person run this themselves:

```bash
npm run keys -- create --email them@example.com --role admin
```

Finish by telling the person, in a few lines: which services are connected, the service account address to
share Drive documents with, and anything they still have to do.
