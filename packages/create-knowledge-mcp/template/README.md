# __NAME__

Your own MCP server, built on [Knowledge MCP](https://github.com/chanthr/internal-mcp) __VERSION__.
Each file in `src/plugins/` is a plugin that adds tools. Document search, Google Drive, Slack, GitHub and Railway
are built in and turn on when they are set up.

## Run

```bash
npm run setup                                             # connect services: asks, checks each value, writes .env
npm run setup -- check                                    # verify every configured service live
npm run dev                                               # http://localhost:8080/mcp, reloads on save. Prints the console address
npm run doctor                                            # which plugins are on, and what each one is missing
```

Clients send the key as `Authorization: Bearer <key>`. State (keys, users, plugin data) lives in `./data`.

## Without writing code

Everything below can also be done in the browser: `npm run dev` prints the address of the console, where you add
folders, connect databases and APIs, write and try tools, and copy the entry for your AI client.

| You have | Do this |
| --- | --- |
| A folder of documents | `npm run setup -- folder <path>`. Searchable right away: no account, no key |
| A Postgres database or a SQLite file | `npm run setup` and pick Database. Or `npm run setup -- connection <name> --postgres --env NAME`, then declare tools in `mcp.config.json` |
| An internal HTTP API | `npm run setup -- connection <name> --http <base URL>`, then declare one request per tool |

Secrets go into `.env` with `npm run setup -- secret <ENV_NAME>`, typed unseen. `npm run setup -- check` connects
to each database and compiles every declared query. The config reference is in the
[Knowledge MCP README](https://github.com/chanthr/internal-mcp#your-data-as-tools). `npm run dev` restarts when
`mcp.config.json` or `.env` changes.

## Add a tool

Copy `src/plugins/notes.ts` to `src/plugins/<name>.ts` and edit it:

```ts
import { definePlugin, defineTool, z } from '@chnxthr/knowledge-mcp';

export default definePlugin({
  id: 'weather',                 // also the permission group
  env: ['WEATHER_API_KEY'],      // tools stay hidden until this is set
  tools: [
    defineTool({
      name: 'weather_now',
      description: 'Current weather for a city',
      input: z.object({ city: z.string().describe('City name') }),
      annotations: { readOnlyHint: true },
      run: async ({ city }) => {
        const r = await fetch(`https://api.example.com/weather?q=${encodeURIComponent(city)}`, {
          headers: { Authorization: `Bearer ${process.env.WEATHER_API_KEY}` },
        });
        return r.json();         // string, any JSON value, or a full MCP result
      },
    }),
  ],
});
```

`run` gets the validated input and a context: `ctx.user` (email, role), `ctx.state` (persistent key-value
storage for this plugin), `ctx.config` (`plugins.<id>` from `mcp.config.json`) and `ctx.log`.
Throw `ToolError` for an expected failure. Files starting with `_` are skipped.

## Connect a client

| Client | How |
| --- | --- |
| Claude Code (local) | `claude mcp add __NAME__ -e MCP_HOME=/absolute/path/__NAME__ -- "$(node -p process.execPath)" /absolute/path/__NAME__/dist/server.js serve --stdio` after `npm run build` |
| Any HTTP client | URL `http://localhost:8080/mcp`, header `Authorization: Bearer <key>` |
| Claude web and desktop connectors | Deploy behind HTTPS and turn on OAuth ([guide](https://github.com/chanthr/internal-mcp/blob/main/OAUTH_SETUP.md)) |

stdio runs as the local admin unless you set `MCP_API_KEY`.

## Permissions

```bash
npm run users -- add teammate@example.com --role member --tools notes,drive
```

Admins see every plugin. Members see every plugin unless `--tools` limits them. Signed-in people without
a users entry are viewers: they get `ping` and the plugins listed in `access.viewerTools` of `mcp.config.json`.

## Deploy

```bash
docker build -t __NAME__ .
docker run -d -p 8080:8080 -v __NAME__-data:/data --env-file .env \
  -v "$PWD/mcp.config.json:/app/mcp.config.json:ro" __NAME__
docker exec <container> node dist/server.js keys create --email you@example.com --role admin
```

| Check | Why |
| --- | --- |
| Keep `/data` on a volume | Keys, users and plugin state live there. Or set `MCP_STORE=supabase` |
| Mount `mcp.config.json` or set `MCP_CONFIG_JSON` | The image holds no config, so without it Drive roots and the sign-in allowlist are empty |
| Set `TRUST_PROXY` | Behind one reverse proxy keep `1` (default). Exposed directly, set `false` so clients cannot fake their IP to dodge the auth rate limit |
| Put it behind HTTPS | Remote clients and OAuth need it |
