# __NAME__

Your own MCP server, built on [Knowledge MCP](https://github.com/chanthr/internal-mcp) __VERSION__.
Each file in `src/plugins/` is a plugin that adds tools. The built-in Google Drive, Slack, GitHub and Railway
plugins turn on when you set their env vars in `.env`.

## Run

```bash
npm run dev                                               # http://localhost:8080/mcp, reloads on save
npm run keys -- create --email you@example.com --role admin   # prints an API key once
npm run doctor                                            # which plugins are on, and what each one is missing
```

Clients send the key as `Authorization: Bearer <key>`. State (keys, users, plugin data) lives in `./data`.

## Add a tool

Copy `src/plugins/notes.ts` to `src/plugins/<name>.ts` and edit it:

```ts
import { definePlugin, defineTool, z } from '@chanthr/knowledge-mcp';

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
| Claude Code (local) | `claude mcp add __NAME__ -- node /absolute/path/__NAME__/dist/server.js serve --stdio` after `npm run build` |
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
docker run -d -p 8080:8080 -v __NAME__-data:/data --env-file .env __NAME__
docker exec <container> node dist/server.js keys create --email you@example.com --role admin
```

Keep `/data` on a volume, or set `MCP_STORE=supabase` to keep state in Supabase.
