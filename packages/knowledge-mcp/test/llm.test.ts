/**
 * A language model for the server's own work: Claude through Anthropic's SDK, and any endpoint that speaks
 * OpenAI's chat completions (OpenRouter, OpenAI, a local model). Both providers are local fakes here, so no key
 * and no text leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-llm-'));
writeFileSync(join(dir, 'mcp.config.json'), '{}');
Object.assign(process.env, { MCP_STORE: 'sqlite', MCP_DATA_DIR: join(dir, 'data'), MCP_CONFIG_PATH: join(dir, 'mcp.config.json'), MCP_ENV_FILE: 'none', KMCP_SUPERVISE: 'false', KNOWLEDGE_CONSOLE: 'on', PORT: '0' });

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { ask, checkLlm, listLlmModels, llmSettings, searchLlmSettings, anthropicEndpoint, LlmError } = await import('../src/core/llm.js');

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
const fakes: Server[] = [];
after(async () => {
  for (const f of fakes) f.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};
const envFile = () => (existsSync(join(dir, '.env')) ? readFileSync(join(dir, '.env'), 'utf8') : '');
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: any };
const fake = async (handle: (seen: Seen) => { status?: number; json?: unknown }) => {
  const seen: Seen[] = [];
  const s = createServer(async (req, res) => {
    const raw = await read(req);
    const one: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(one);
    const out = handle(one);
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  fakes.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
};

/** A service like OpenRouter: a list of models, and chat completions, for one key. */
const openrouter = async () => {
  const st = { busy: 0 };
  const f = await fake((r) => {
    if (r.headers.authorization !== 'Bearer or-key-000000') return { status: 401, json: { error: { message: 'No auth credentials found' } } };
    if (r.method === 'GET' && r.url === '/v1/models') return { json: { data: [{ id: 'zeta/large', name: 'Zeta Large' }, { id: 'acme/small:free' }] } };
    if (r.method === 'POST' && r.url === '/v1/chat/completions') {
      if (st.busy > 0) return st.busy--, { status: 429, json: { error: { message: 'slow down' } } };
      if (r.body.model === 'gone/model') return { status: 404, json: { error: { message: 'No endpoints found' } } };
      const user = r.body.messages.at(-1).content as string;
      return { json: { model: r.body.model, choices: [{ message: { content: user.includes('single word') ? 'ready' : `echo: ${user}` }, finish_reason: user.includes('long') ? 'length' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } } };
    }
    return { status: 404, json: {} };
  });
  return { ...f, st, base: `${f.url}/v1` };
};

test('an OpenAI-compatible provider: its models, an answer, and what goes wrong said plainly', async () => {
  const or = await openrouter();
  const s = { kind: 'openai' as const, baseUrl: or.base, apiKey: 'or-key-000000' };
  assert.deepEqual(await listLlmModels(s), [{ id: 'acme/small:free', name: 'acme/small:free' }, { id: 'zeta/large', name: 'Zeta Large' }]);

  const a = await ask({ system: 'Answer briefly.', prompt: 'hello' }, { ...s, model: 'zeta/large' });
  assert.deepEqual([a.text, a.model, a.usage, a.cutOff], ['echo: hello', 'zeta/large', { input: 12, output: 3, cached: 8 }, false]);
  const sent = or.seen.at(-1)!;
  assert.deepEqual(sent.body, { model: 'zeta/large', messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'hello' }] });
  assert.equal((await ask({ prompt: 'a long one' }, { ...s, model: 'zeta/large' })).cutOff, true);

  // Busy for a moment: asked again, and the answer comes. Out of patience: said, and marked as worth another try.
  or.st.busy = 1;
  assert.equal((await ask({ prompt: 'hello' }, { ...s, model: 'zeta/large' })).text, 'echo: hello');
  await assert.rejects(() => ask({ prompt: 'x' }, { ...s, apiKey: 'wrong', model: 'zeta/large' }), (e: unknown) => e instanceof LlmError && !e.retry && /did not accept the API key/.test(e.message));
  await assert.rejects(() => ask({ prompt: 'x' }, { ...s, model: 'gone/model' }), /does not know that model/);
  await assert.rejects(() => listLlmModels({ kind: 'openai', baseUrl: `${or.url}/nothing-here`, apiKey: 'or-key-000000' }), /does not know that model, or this is not the address of its API/);
  await assert.rejects(() => ask({ prompt: 'x' }, null), /No model is connected/);
});

test('Claude: through Anthropic\'s SDK, with the instructions marked to be kept and a declined request said', async () => {
  const message = (model: string, text: string, stop = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });
  const claude = await fake((r) => {
    // The SDK sends the key as a bearer token (older versions: the x-api-key header).
    if (r.headers.authorization !== 'Bearer sk-ant-test-000000' && r.headers['x-api-key'] !== 'sk-ant-test-000000') return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    if (r.method === 'GET' && r.url.startsWith('/v1/models')) return { json: { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }, { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-5-5' } };
    if (r.method === 'POST' && r.url.startsWith('/v1/messages')) {
      const user = r.body.messages.at(-1).content as string;
      if (user.includes('decline')) return { json: { ...message(r.body.model, '', 'refusal'), content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: null } } };
      return { json: message(r.body.model, user.includes('single word') ? 'ready' : 'a summary') };
    }
    return { status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'not found' } } };
  });
  anthropicEndpoint.baseURL = claude.url;
  const s = { kind: 'anthropic' as const, apiKey: 'sk-ant-test-000000' };
  assert.deepEqual(await listLlmModels(s), [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }]);

  const a = await ask({ system: 'The rules of the wiki.', prompt: 'Summarize this.' }, { ...s, model: 'claude-haiku-5-5' });
  assert.deepEqual([a.text, a.model, a.usage, a.cutOff], ['a summary', 'claude-haiku-5-5', { input: 920, output: 4, cached: 900 }, false]);
  const plain = claude.seen.at(-1)!;
  // The instructions carry the mark that lets the provider keep them between calls. Thinking is left to the model.
  assert.deepEqual(plain.body.system, [{ type: 'text', text: 'The rules of the wiki.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual([plain.body.max_tokens, 'thinking' in plain.body, 'fallbacks' in plain.body, plain.url], [16_000, false, false, '/v1/messages']);

  // On the models that have it, a declined request is handed to another model by Anthropic inside the same call.
  await ask({ prompt: 'Summarize this.' }, { ...s, model: 'claude-opus-5-5' });
  const withFallback = claude.seen.at(-1)!;
  assert.deepEqual([withFallback.body.fallbacks, String(withFallback.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), withFallback.url], ['default', true, '/v1/messages']);

  await assert.rejects(() => ask({ prompt: 'please decline' }, { ...s, model: 'claude-haiku-5-5' }), /The model declined this request \(cyber\)\./);
  await assert.rejects(() => listLlmModels({ kind: 'anthropic', apiKey: 'wrong' }), /Anthropic did not accept the API key\./);
  assert.deepEqual(await checkLlm({ ...s, model: 'claude-haiku-5-5' }), { model: 'claude-haiku-5-5' });
});

test('the console connects a model: the provider\'s own list, a live check, and a key that is saved and never shown', async () => {
  const or = await openrouter();
  assert.deepEqual((await api('GET', '/state')).json.services.llm, { set: false, provider: null, model: null, baseUrl: null, keySet: false });

  const listed = await api('POST', '/llm/models', { provider: 'openai', baseUrl: `${or.base}/`, apiKey: 'or-key-000000' });
  assert.deepEqual([listed.status, listed.json.models.map((m: any) => m.id)], [200, ['acme/small:free', 'zeta/large']]);
  assert.match((await api('POST', '/llm/models', { provider: 'openai', baseUrl: or.base, apiKey: 'wrong-key-000' })).json.error, /did not accept the API key/);
  assert.match((await api('POST', '/llm/models', { provider: 'openai' })).json.error, /The address of the API is needed/);
  assert.match((await api('POST', '/llm/models', { provider: 'anthropic' })).json.error, /Claude needs an API key/);

  // Saved only after the model answered. The key goes to .env and is in no answer.
  const bad = await api('POST', '/services/llm', { provider: 'openai', baseUrl: or.base, apiKey: 'or-key-000000', model: 'gone/model' });
  assert.deepEqual([bad.status, /does not know that model/.test(bad.json.error), envFile().includes('LLM_')], [422, true, false]);
  const saved = await api('POST', '/services/llm', { provider: 'openai', baseUrl: or.base, apiKey: 'or-key-000000', model: 'zeta/large' });
  assert.deepEqual([saved.status, saved.json.found], [200, 'zeta/large answered'], saved.text);
  assert.ok(!saved.text.includes('or-key-000000'));
  assert.match(envFile(), /^LLM_PROVIDER=openai$/m);
  assert.match(envFile(), /^LLM_MODEL=zeta\/large$/m);
  assert.match(envFile(), /^LLM_API_KEY=or-key-000000$/m);
  assert.ok(envFile().includes(`LLM_BASE_URL=${or.base}`));

  // As after the restart that follows a save.
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: or.base, LLM_API_KEY: 'or-key-000000', LLM_MODEL: 'zeta/large' });
  assert.deepEqual(llmSettings(), { kind: 'openai', baseUrl: or.base, apiKey: 'or-key-000000', model: 'zeta/large' });
  const state = await api('GET', '/state');
  assert.deepEqual(state.json.services.llm, { set: true, provider: 'openai', model: 'zeta/large', baseUrl: or.base, keySet: true });
  assert.ok(!state.text.includes('or-key-000000'));

  // The saved key is used again for the provider and address it was saved for, and goes nowhere else.
  const other = await openrouter();
  assert.equal((await api('POST', '/llm/models', { provider: 'openai', baseUrl: or.base })).status, 200);
  const elsewhere = await api('POST', '/llm/models', { provider: 'openai', baseUrl: other.base });
  assert.match(elsewhere.json.error, /did not accept the API key/);
  assert.equal(other.seen.at(-1)!.headers.authorization, undefined, 'the saved key was not sent to another address');

  // Disconnected: every setting of it leaves .env.
  assert.equal((await api('DELETE', '/services/llm')).status, 200);
  assert.ok(!/^LLM_(PROVIDER|MODEL|API_KEY|BASE_URL)=/m.test(envFile()), envFile());
  for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) delete process.env[k];
});

test('the search assistant can have a model of its own, and a saved key goes only where it was given', async () => {
  const or = await openrouter();
  assert.equal((await api('POST', '/services/llm', { provider: 'openai', baseUrl: or.base, apiKey: 'or-key-000000', model: 'zeta/large' })).status, 200);
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: or.base, LLM_API_KEY: 'or-key-000000', LLM_MODEL: 'zeta/large' });
  assert.deepEqual(searchLlmSettings(), llmSettings(), 'without one of its own, the search assistant uses the language model');
  assert.equal((await api('GET', '/state')).json.services.searchLlm.set, false);

  // Its own model on the same provider and address: the language model's key is used, and not saved twice.
  assert.equal((await api('POST', '/llm/models', { provider: 'openai', baseUrl: or.base, for: 'search-llm' })).status, 200);
  const own = await api('POST', '/services/search-llm', { provider: 'openai', baseUrl: or.base, model: 'acme/small:free', for: 'search-llm' });
  assert.deepEqual([own.status, own.json.found], [200, 'acme/small:free answered'], own.text);
  assert.match(envFile(), /^SEARCH_LLM_MODEL=acme\/small:free$/m);
  assert.ok(!/^SEARCH_LLM_API_KEY=/m.test(envFile()), envFile());
  Object.assign(process.env, { SEARCH_LLM_PROVIDER: 'openai', SEARCH_LLM_BASE_URL: or.base, SEARCH_LLM_MODEL: 'acme/small:free' });
  assert.deepEqual(searchLlmSettings(), { kind: 'openai', baseUrl: or.base, apiKey: 'or-key-000000', model: 'acme/small:free' });
  assert.deepEqual((await api('GET', '/state')).json.services.searchLlm, { set: true, provider: 'openai', model: 'acme/small:free', baseUrl: or.base, keySet: false });

  // A model on this machine for search: the OpenRouter key does not go there.
  const local = await fake((r) => (r.url === '/v1/models' ? { json: { data: [{ id: 'small' }] } } : { json: { model: 'small', choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] } }));
  Object.assign(process.env, { SEARCH_LLM_BASE_URL: `${local.url}/v1`, SEARCH_LLM_MODEL: 'small' });
  assert.equal(searchLlmSettings()?.apiKey, undefined);

  // The language model moved to an address that needs no key: the old key is not kept for it.
  const moved = await api('POST', '/services/llm', { provider: 'openai', baseUrl: `${local.url}/v1`, model: 'small' });
  assert.equal(moved.status, 200, moved.text);
  assert.ok(!/^LLM_API_KEY=/m.test(envFile()), 'the OpenRouter key is not kept for another address');
  assert.ok(local.seen.every((r) => !r.headers.authorization), 'no key was sent to this machine');

  // Back to the language model.
  assert.equal((await api('DELETE', '/services/search-llm')).status, 200);
  assert.ok(!/^SEARCH_LLM_(PROVIDER|MODEL|BASE_URL|API_KEY)=/m.test(envFile()), envFile());
  assert.equal((await api('DELETE', '/services/llm')).status, 200);
  for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'SEARCH_LLM_PROVIDER', 'SEARCH_LLM_BASE_URL', 'SEARCH_LLM_MODEL']) delete process.env[k];
});
