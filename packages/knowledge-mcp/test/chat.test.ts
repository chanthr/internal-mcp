/**
 * The console's chat: the connected model answers with this server's tools, and every step reaches the page as it
 * happens. Both providers are local fakes that stream the way the real ones do, so no key and no text leaves
 * this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-chat-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
writeFileSync(join(docs, 'deploy.md'), '# Deploy\n\nProduction deploys go out from the main branch after one review. Rollback uses the previous image.\n');
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
});

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { anthropicEndpoint } = await import('../src/core/llm.js');
const { visibleText } = await import('../src/core/llm_chat.js');
const { scanFolders } = await import('../src/plugins/knowledge/folders.js');

await scanFolders();
const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
const fakes: Server[] = [];
after(async () => {
  for (const f of fakes) f.close();
  await server.close();
});

/** Ask the chat; returns the events it sent back, in order. */
async function chat(message: string, history: Array<{ role: string; text: string }> = []): Promise<{ status: number; events: any[]; text: string }> {
  const res = await fetch(`${base}/console/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history }) });
  const text = await res.text();
  const events = res.headers.get('content-type')?.includes('ndjson') ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { status: res.status, events, text };
}
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
/** A provider that answers each request with the next script: a list of server-sent events. */
async function provider(scripts: Array<(res: ServerResponse) => void>): Promise<{ url: string; seen: Array<{ url: string; headers: IncomingMessage['headers']; body: any }> }> {
  const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: any }> = [];
  const s = createServer(async (req, res) => {
    const raw = await read(req);
    seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const next = scripts[Math.min(seen.length - 1, scripts.length - 1)];
    next(res);
  });
  fakes.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}
const sse = (res: ServerResponse, events: Array<{ event?: string; data: unknown }>) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  res.end();
};
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ data: { model: 'local-model', choices: [{ index: 0, delta: d, finish_reason: finish }] } });

test('reasoning in <think> is hidden, even when its tag arrives in pieces', () => {
  assert.equal(visibleText('<think>plan it</think>The answer', true), 'The answer');
  assert.equal(visibleText('<think>still planning', false), '');
  assert.equal(visibleText('Hello <thi', false), 'Hello ');
  assert.equal(visibleText('Hello <thi', true), 'Hello <thi');
  assert.equal(visibleText('a < b', false), 'a < b');
});

test('without a connected model the chat says where to connect one', async () => {
  const r = await chat('hello');
  assert.equal(r.status, 409);
  assert.match(r.text, /Models page/);
});

test('an OpenAI-style endpoint: the model searches, the result goes back to it, and the answer streams to the page', async () => {
  const p = await provider([
    (res) =>
      sse(res, [
        delta({ role: 'assistant', reasoning: 'The person asks about deploys.' }),
        delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_knowledge', arguments: '{"query": "dep' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'loys main branch"}' } }] }),
        delta({}, 'tool_calls'),
        { data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } } },
        { data: '[DONE]' },
      ]),
    (res) =>
      sse(res, [
        delta({ content: '<think>The guide' }),
        delta({ content: ' says it.</think>Deploys go out from ' }),
        delta({ content: 'the main branch after one review (deploy.md). <thi' }),
        delta({ content: 'nk>done</think>' }),
        delta({}, 'stop'),
        { data: { choices: [], usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 90 } } } },
        { data: '[DONE]' },
      ]),
  ]);
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: `${p.url}/v1`, LLM_MODEL: 'local-model', LLM_API_KEY: 'test-key' });
  try {
    const r = await chat('How do deploys go out?', [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello.' }]);
    assert.equal(r.status, 200);
    const types = r.events.map((e) => e.type);
    // First the conversation it is kept in, then the answer.
    assert.deepEqual([types[0], types[1], types.at(-1)], ['chat', 'thinking', 'done']);
    const call = r.events.find((e) => e.type === 'tool');
    assert.deepEqual([call.name, call.input], ['search_knowledge', { query: 'deploys main branch' }]);
    const result = r.events.find((e) => e.type === 'result');
    assert.equal(result.ok, true);
    assert.match(result.text, /main branch after one review/);
    const answer = r.events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.equal(answer, 'Deploys go out from the main branch after one review (deploy.md). ');
    assert.deepEqual(r.events.at(-1), { type: 'done', model: 'local-model', usage: { input: 400, output: 60, cached: 90, steps: 1 }, note: null });

    // What the provider was given.
    const [first, second] = p.seen;
    assert.equal(first.url, '/v1/chat/completions');
    assert.equal(first.headers.authorization, 'Bearer test-key');
    assert.deepEqual([first.body.stream, first.body.stream_options], [true, { include_usage: true }]);
    assert.deepEqual(first.body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.match(first.body.messages[0].content, /owner tries how its tools work/);
    const names = first.body.tools.map((t: any) => t.function.name).sort();
    // With a model connected, the search assistant is one of the tools too; save_note is the one that writes (notes/).
    assert.deepEqual(names, ['find_documents', 'linked_documents', 'read_document', 'save_note', 'search_knowledge']);
    assert.ok(first.body.tools.every((t: any) => !('$schema' in t.function.parameters) && t.function.parameters.type === 'object'));
    const turn = second.body.messages.slice(-2);
    assert.deepEqual(turn[0].tool_calls, [{ id: 'call_a', type: 'function', function: { name: 'search_knowledge', arguments: '{"query": "deploys main branch"}' } }]);
    assert.equal(turn[1].role, 'tool');
    assert.equal(turn[1].tool_call_id, 'call_a');
    assert.match(turn[1].content, /main branch after one review/);
  } finally {
    for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];
  }
});

test('a server that does not take stream_options is asked again without; a tool that does not exist is told so', async () => {
  const p = await provider([
    (res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown field: stream_options' } }));
    },
    (res) => sse(res, [delta({ tool_calls: [{ index: 0, function: { name: 'drop_tables', arguments: '{}' } }] }), delta({}, 'tool_calls'), { data: '[DONE]' }]),
    (res) => sse(res, [delta({ content: 'I cannot do that here.' }), delta({}, 'stop'), { data: '[DONE]' }]),
  ]);
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: `${p.url}/v1`, LLM_MODEL: 'local-model' });
  try {
    const r = await chat('Delete everything');
    assert.equal(p.seen.length, 3);
    assert.equal(p.seen[1].body.stream_options, undefined);
    assert.equal(p.seen[1].headers.authorization, undefined, 'no key, no header');
    const result = r.events.find((e) => e.type === 'result');
    assert.deepEqual([result.ok, result.text], [false, 'There is no tool named drop_tables here.']);
    assert.equal(r.events.at(-1).type, 'done');
  } finally {
    for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL']) delete process.env[k];
  }
});

/** Claude's stream, as Anthropic sends it. */
const claudeStream = (res: ServerResponse, model: string, blocks: Array<{ text: string } | { id: string; name: string; json: string[] }>, stop: string) => {
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 40 } } } },
  ];
  blocks.forEach((b, index) => {
    if ('text' in b) {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      for (const piece of b.text.match(/.{1,6}/g) ?? []) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } });
    } else {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
      for (const part of b.json) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  sse(res, events);
};

test("Claude through Anthropic's SDK: tool use in a loop, the result handed back by its id, the answer streamed", async () => {
  const p = await provider([
    (res) => claudeStream(res, 'claude-test', [{ text: 'Let me look.' }, { id: 'toolu_1', name: 'search_knowledge', json: ['{"query": "roll', 'back"}'] }], 'tool_use'),
    (res) => claudeStream(res, 'claude-test', [{ text: 'Rollback uses the previous image.' }], 'end_turn'),
  ]);
  anthropicEndpoint.baseURL = p.url;
  Object.assign(process.env, { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-test', LLM_API_KEY: 'sk-ant-test' });
  try {
    const r = await chat('How is a deploy rolled back?');
    assert.equal(r.status, 200);
    assert.equal(r.events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Let me look.Rollback uses the previous image.');
    assert.deepEqual(r.events.find((e) => e.type === 'tool').input, { query: 'rollback' });
    assert.match(r.events.find((e) => e.type === 'result').text, /previous image/);
    assert.deepEqual(r.events.at(-1), { type: 'done', model: 'claude-test', usage: { input: 180, output: 60, cached: 80, steps: 1 }, note: null });

    const [first, second] = p.seen;
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.body.stream, true);
    assert.equal(first.body.system[0].cache_control.type, 'ephemeral');
    assert.ok(first.body.tools.every((t: any) => t.eager_input_streaming === true && !('$schema' in t.input_schema)));
    const [assistant, user] = second.body.messages.slice(-2);
    assert.deepEqual(assistant.content.map((b: any) => b.type), ['text', 'tool_use']);
    assert.deepEqual([user.content[0].type, user.content[0].tool_use_id], ['tool_result', 'toolu_1']);
    assert.match(user.content[0].content, /previous image/);
  } finally {
    for (const k of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];
    delete anthropicEndpoint.baseURL;
  }
});

test('a model with server-side fallback is asked through the beta, and a refusal ends the answer with a sentence', async () => {
  const p = await provider([(res) => claudeStream(res, 'claude-opus-5-5', [{ text: '' }], 'refusal')]);
  anthropicEndpoint.baseURL = p.url;
  Object.assign(process.env, { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-opus-5-5', LLM_API_KEY: 'sk-ant-test' });
  try {
    const r = await chat('Something it will not do');
    assert.match(String(p.seen[0].headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(p.seen[0].body.fallbacks, 'default');
    assert.deepEqual(r.events.at(-1), { type: 'error', message: 'The model declined this request.' });
  } finally {
    for (const k of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];
    delete anthropicEndpoint.baseURL;
  }
});

test('closing the page stops the model: the request to the provider is dropped too', async () => {
  let dropped: () => void = () => {};
  const gone = new Promise<void>((r) => (dropped = r));
  const p = await provider([
    (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(delta({ content: 'Starting a long answer' }).data)}\n\n`);
      res.on('close', () => dropped()); // never ends by itself
    },
  ]);
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: `${p.url}/v1`, LLM_MODEL: 'local-model' });
  try {
    const stop = new AbortController();
    const res = await fetch(`${base}/console/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Write a lot' }), signal: stop.signal });
    const reader = res.body!.getReader();
    let first = '';
    while (!/Starting a long answer/.test(first)) first += new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /^\{"type":"chat"[^\n]*\n[\s\S]*Starting a long answer/);
    stop.abort();
    await Promise.race([gone, new Promise((_, no) => setTimeout(() => no(new Error('the provider request was not dropped')), 3000))]);
  } finally {
    for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL']) delete process.env[k];
  }
});
