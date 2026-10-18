/** Plugin API, registry, loader and permission checks — no network, no store writes except plugin state. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Credentials from the developer's shell would turn built-in plugins on.
for (const k of Object.keys(process.env)) {
  if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|MCP_OAUTH|OAUTH_)/.test(k)) delete process.env[k];
}
process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-plugin-'));
process.env.MCP_STORE = 'sqlite';
process.env.MCP_CONFIG_JSON = JSON.stringify({ access: { viewerTools: ['open'] }, plugins: { cfg: { greeting: 'hi' } } });

const { z } = await import('zod');
const { definePlugin, defineTool, ToolError } = await import('../src/plugin/define.js');
const { Registry } = await import('../src/plugin/registry.js');
const { loadPlugins } = await import('../src/plugin/load.js');
const { isToolAllowed } = await import('../src/core/scope.js');
const { pingTool } = await import('../src/plugin/ping.js');
const { builtinPlugins } = await import('../src/plugins/index.js');

const admin = { ok: true, role: 'admin' as const, email: 'a@x.com' };
const member = { ok: true, role: 'member' as const, email: 'm@x.com' };
const viewer = { ok: true, role: 'viewer' as const, email: 'v@x.com' };
const text = (r: { content: Array<{ type: string; text?: unknown }> }) => String(r.content[0]?.text ?? '');

test('defineTool and definePlugin reject bad names early', () => {
  assert.throws(() => defineTool({ name: 'Bad-Name', description: 'x', run: () => '' }), /invalid tool name/);
  assert.throws(() => defineTool({ name: 'ok', description: ' ', run: () => '' }), /needs a description/);
  assert.throws(() => definePlugin({ id: 'Bad_Id', tools: [] }), /invalid plugin id/);
  const t = defineTool({ name: 'dup', description: 'x', run: () => '' });
  assert.throws(() => definePlugin({ id: 'p', tools: [t, t] }), /duplicate tool name/);
});

test('registry rejects clashes across plugins and the reserved ping name', () => {
  const a = definePlugin({ id: 'a', tools: [defineTool({ name: 'same', description: 'x', run: () => '' })] });
  const b = definePlugin({ id: 'b', tools: [defineTool({ name: 'same', description: 'x', run: () => '' })] });
  assert.throws(() => new Registry([a, b]), /defined by both "a" and "b"/);
  assert.throws(() => new Registry([a, definePlugin({ id: 'a', tools: [] })]), /two plugins use the id/);
  const p = definePlugin({ id: 'p', tools: [defineTool({ name: 'ping', description: 'x', run: () => '' })] });
  assert.throws(() => new Registry([p]), /reserved/);
});

test('env gating hides tools and explains why', () => {
  const p = definePlugin({
    id: 'gate',
    env: ['KMCP_UNIT_GATE'],
    tools: [defineTool({ name: 'gate_t', description: 'x', run: () => 'ok' })],
  });
  const r = new Registry([p]);
  assert.deepEqual(r.listTools(pingTool).map((t) => t.name), ['ping']);
  assert.match(r.status()[0]!.reason!, /missing env KMCP_UNIT_GATE/);
  process.env.KMCP_UNIT_GATE = '1';
  assert.deepEqual(r.listTools(pingTool).map((t) => t.name), ['ping', 'gate_t']);
  delete process.env.KMCP_UNIT_GATE;
});

test('input is validated, results and errors are normalized', async () => {
  const p = definePlugin({
    id: 'n',
    tools: [
      defineTool({ name: 'n_text', description: 'x', input: z.object({ a: z.string() }), run: ({ a }) => `got ${a}` }),
      defineTool({ name: 'n_json', description: 'x', run: () => ({ k: 1 }) }),
      defineTool({ name: 'n_mcp', description: 'x', run: () => ({ content: [{ type: 'text', text: 'raw' }] }) }),
      defineTool({ name: 'n_toolerr', description: 'x', run: () => { throw new ToolError('nope'); } }),
      defineTool({ name: 'n_crash', description: 'x', run: () => { throw new Error('boom'); } }),
      defineTool({ name: 'n_off', description: 'x', enabled: () => 'needs FOO', run: () => 'never' }),
    ],
  });
  const r = new Registry([p]);
  assert.equal(text(await r.call('n_text', { a: 'b' }, admin)), 'got b');
  const bad = await r.call('n_text', { a: 1 }, admin);
  assert.equal(bad.isError, true);
  assert.match(text(bad), /^\[invalid_input\] .*a: Expected string/);
  assert.deepEqual(JSON.parse(text(await r.call('n_json', {}, admin))), { k: 1 });
  assert.equal(text(await r.call('n_mcp', {}, admin)), 'raw');
  assert.equal(text(await r.call('n_toolerr', {}, admin)), '[error] nope');
  assert.equal(text(await r.call('n_crash', {}, admin)), '[fatal] boom');
  assert.match(text(await r.call('n_off', {}, admin)), /설정되지 않았습니다 \(needs FOO\)/);
  assert.equal(text(await r.call('nope', {}, admin)), 'Unknown tool: nope');
});

test('refined zod schemas keep their properties in tools/list', () => {
  const p = definePlugin({
    id: 'r',
    tools: [
      defineTool({
        name: 'r_one',
        description: 'x',
        input: z.object({ a: z.string().optional().describe('A'), b: z.string().optional() }).refine((v) => v.a || v.b),
        run: () => '',
      }),
    ],
  });
  const tool = new Registry([p]).listTools(pingTool).find((t) => t.name === 'r_one')!;
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['a', 'b']);
  assert.equal((tool.inputSchema.properties as Record<string, { description?: string }>).a?.description, 'A');
  assert.equal('$schema' in tool.inputSchema, false);
});

test('non-object input schema fails at boot', () => {
  const p = definePlugin({ id: 's', tools: [defineTool({ name: 's_t', description: 'x', input: z.string() as never, run: () => '' })] });
  assert.throws(() => new Registry([p]), /must be a zod object schema/);
});

test('plugin config is validated with configSchema and passed as ctx.config', async () => {
  const p = definePlugin({
    id: 'cfg',
    configSchema: z.object({ greeting: z.string() }),
    tools: [defineTool({ name: 'cfg_t', description: 'x', run: (_i, ctx) => (ctx.config as { greeting: string }).greeting })],
  });
  assert.equal(text(await new Registry([p]).call('cfg_t', {}, admin)), 'hi');
  const strict = definePlugin({ id: 'cfg', configSchema: z.object({ greeting: z.number() }), tools: [] });
  assert.throws(() => new Registry([strict]), /plugins\.cfg/);
});

test('plugin state persists per plugin', async () => {
  const p = definePlugin({
    id: 'st',
    tools: [
      defineTool({
        name: 'st_inc',
        description: 'x',
        run: async (_i, ctx) => {
          const n = ((await ctx.state.get<number>('n')) ?? 0) + 1;
          await ctx.state.set('n', n);
          return String(n);
        },
      }),
    ],
  });
  const r = new Registry([p]);
  assert.equal(text(await r.call('st_inc', {}, admin)), '1');
  assert.equal(text(await r.call('st_inc', {}, admin)), '2');
});

test('instructions: base line plus enabled plugins, or the config override', () => {
  const on = definePlugin({ id: 'on', instructions: 'On notes.', tools: [] });
  const off = definePlugin({ id: 'off', env: ['KMCP_NEVER_SET'], instructions: 'Off notes.', tools: [] });
  const i = new Registry([on, off]).instructions();
  assert.match(i, /On notes\./);
  assert.doesNotMatch(i, /Off notes\./);
});

test('permissions: admin all, member by allowed_tools, viewer by viewerTools, ping always', () => {
  assert.equal(isToolAllowed(admin, 'x', 'drive'), true);
  assert.equal(isToolAllowed(member, 'x', 'drive'), true);
  assert.equal(isToolAllowed({ ...member, scopes: { tools: ['slack'] } }, 'x', 'drive'), false);
  assert.equal(isToolAllowed({ ...member, scopes: { tools: ['slack'] } }, 'x', 'slack'), true);
  assert.equal(isToolAllowed(viewer, 'x', 'drive'), false);
  assert.equal(isToolAllowed(viewer, 'x', 'open'), true); // config access.viewerTools
  assert.equal(isToolAllowed(viewer, 'ping', null), true);
  assert.equal(isToolAllowed(member, 'unknown', null), false);
});

test('loadPlugins loads every plugin file and skips _ files', async () => {
  const plugins = await loadPlugins(new URL('./fixtures/plugins/', import.meta.url));
  assert.deepEqual(plugins.map((p) => p.id), ['echo', 'gated']);
  assert.deepEqual(await loadPlugins('/nonexistent-dir-for-test'), []);
});

test('built-in plugins load with no credentials and stay off', () => {
  const r = new Registry(builtinPlugins);
  assert.deepEqual(r.status().map((s) => [s.id, s.enabled]), [['drive', false], ['slack', false], ['github', false], ['railway', false]]);
  assert.deepEqual(r.listTools(pingTool).map((t) => t.name), ['ping']);
});
