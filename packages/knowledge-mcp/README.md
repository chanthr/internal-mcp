# @chnxthr/knowledge-mcp

Build your team's own MCP server from plugins. API keys, Google sign-in (OAuth 2.1), per-person permissions,
an audit log and a SQLite or Supabase store are built in, and so are Google Drive, Slack, GitHub and Railway.

```bash
npx create-knowledge-mcp my-mcp     # a ready project with an example plugin
```

```ts
// src/plugins/weather.ts — every file in src/plugins is a plugin
import { definePlugin, defineTool, z } from '@chnxthr/knowledge-mcp';

export default definePlugin({
  id: 'weather',
  env: ['WEATHER_API_KEY'],
  tools: [
    defineTool({
      name: 'weather_now',
      description: 'Current weather for a city',
      input: z.object({ city: z.string().describe('City name') }),
      run: async ({ city }) => (await fetch(`https://api.example.com/weather?q=${city}`)).json(),
    }),
  ],
});
```

Run it without a project too:

```bash
npx @chnxthr/knowledge-mcp doctor        # which built-in connectors are on
npx @chnxthr/knowledge-mcp keys create --email you@example.com --role admin
npx @chnxthr/knowledge-mcp serve         # http://localhost:8080/mcp
```

Requires Node 22.13 or later. Documentation: https://github.com/chanthr/internal-mcp

MIT © chanthr
