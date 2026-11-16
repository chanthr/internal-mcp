# Contributing

Issues and pull requests are welcome. For a bug or an idea, start with an issue so the approach can be agreed
before code is written.

## Setup

You need Node 22.13 or later.

```bash
git clone https://github.com/chanthr/internal-mcp.git
cd internal-mcp
npm install
npm run dev        # http://localhost:8080/mcp
```

The repository is an npm workspace with two packages.

| Package | What it is |
| --- | --- |
| `packages/knowledge-mcp` | The server: plugin API, auth, stores, built-in plugins, CLI |
| `packages/create-knowledge-mcp` | The project generator and its template. No dependencies |

## Checks

Run these before opening a pull request. CI runs the same ones.

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | Types |
| `npm test` | Unit and end-to-end tests over HTTP and stdio. Tests that need a real Qdrant are skipped unless `QDRANT_TEST_URL` is set |
| `npm run smoke:create` | Pack, scaffold a project, install, build, serve and call a tool |
| `npm run check:install` | A fresh install prints no deprecation warning and `npm audit` is clean |

`check:install` is the reason dependencies are kept few. Before adding one, check what it pulls in. A dependency
that brings a deprecation warning or an audit finding will fail CI.

## Adding a plugin

A plugin is one file that calls `definePlugin`. The built-in ones in `packages/knowledge-mcp/src/plugins/` are the
reference, and the README section "Plugin API" lists every field.

1. The plugin id is its permission group. Pick a short lowercase name.
2. Declare the env vars it needs in `env` so `knowledge-mcp doctor` can say what is missing.
3. Validate tool input with a zod schema. Return a string, an object, or an MCP result.
4. Built-in plugins only read. Mark tools with `annotations: { readOnlyHint: true }`.
5. Add a test next to the existing ones in `packages/knowledge-mcp/test/`. Tests use fakes for remote services
   and do not need credentials.

## Style

- Comments, tool descriptions, error messages and documentation are in English. `README.ko.md` is the Korean
  translation of the README and is updated in the same pull request.
- Comments say why, not what. Keep the reason a guard exists next to the guard.
- A tool does not show what it could not check: when a permission or folder lookup fails, hide the result.
- User-facing changes get an entry in `CHANGELOG.md`.

## Security

Do not put API keys, tokens, internal URLs or private documents in issues, pull requests or tests.
Report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md).
