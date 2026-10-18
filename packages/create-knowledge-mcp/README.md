# create-knowledge-mcp

Scaffolds your own [Knowledge MCP](https://github.com/chanthr/internal-mcp) server.

```bash
npx create-knowledge-mcp my-mcp
# or: npm create knowledge-mcp@latest my-mcp
cd my-mcp
npm run dev
```

You get `src/server.ts`, an example plugin in `src/plugins/notes.ts`, `.env`, a `Dockerfile` and a README.
Add a tool by adding a file to `src/plugins/`.

| Option | Meaning |
| --- | --- |
| `--no-install` | Skip installing packages |
| `--no-git` | Skip `git init` |

Installs with the package manager that ran it (npm, pnpm, yarn or bun). Requires Node 22.13 or later.

MIT © chanthr
