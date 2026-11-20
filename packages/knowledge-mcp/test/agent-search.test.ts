/**
 * The search assistant (find_documents): a model searches the documents several times, reads where it needs to,
 * and reports the documents that answer. The model is a local fake that streams as an OpenAI-compatible endpoint
 * does and decides from what it is sent, so no key and no text leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|SEARCH_LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-agent-'));
const docs = join(dir, 'docs');
mkdirSync(join(docs, 'ops'), { recursive: true });
mkdirSync(join(docs, 'hr'), { recursive: true });
writeFileSync(join(docs, 'ops', 'deploy.md'), '# Deploy\n\nProduction deploys go out from the main branch after one review.\n');
writeFileSync(join(docs, 'ops', 'rollback.md'), '# Rollback\n\nTo roll back, redeploy the previous image tag from the registry.\n');
writeFileSync(join(docs, 'hr', 'holidays.md'), '# Holidays\n\nThe office closes for the new year holidays.\n');
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_SCAN_ENABLED: 'false',
});

const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { agentSearch, excerpt, fuseRanks } = await import('../src/plugins/knowledge/agent_search.js');
const { findDocumentsTool, render } = await import('../src/plugins/knowledge/tools/find_documents.js');
const { placeOf, scoreOf, scoreQuestions } = await import('../src/plugins/knowledge/eval.js');
const { authStore } = await import('../src/core/context.js');
await scanFolders();

const fakes: Server[] = [];
after(() => {
  for (const f of fakes) f.close();
});

type Body = { model: string; stream?: boolean; max_tokens?: number; messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>; tools?: Array<{ function: { name: string } }> };
type Answer = { calls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string; fail?: boolean };
/** A model that answers each request from what it is sent: tool calls or text, streamed. */
async function model(decide: (body: Body) => Answer): Promise<{ base: string; seen: Body[] }> {
  const seen: Body[] = [];
  const s = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Body;
    seen.push(body);
    const a = decide(body);
    if (a.fail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'invalid tool call arguments for "report"' } }));
    }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: a.text ?? '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (a.text) send({ model: 'fake-model', choices: [{ index: 0, delta: { content: a.text }, finish_reason: null }] });
    (a.calls ?? []).forEach((c, i) => send({ model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${seen.length}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] }));
    send({ model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: a.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    res.end('data: [DONE]\n\n');
  });
  fakes.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
  Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: base, LLM_MODEL: 'fake-model' });
  return { base, seen };
}
const toolResults = (b: Body) => b.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
/** The name a document was given in this conversation (d1, d2, …), from what the model was shown. */
const aliasIn = (b: Body, path: string) => new RegExp(`(d\\d+) · ${path.replace(/[.]/g, '\\.')}`).exec(b.messages.map((m) => String(m.content ?? '')).join('\n'))?.[1] ?? 'none';
const owner = { ok: true, org_id: 'default', role: 'admin' as const, email: 'owner@example.com' };
const asOwner = <T>(fn: () => Promise<T>) => authStore.run(owner, fn);
type Auth = { ok: boolean; org_id: string; role: 'admin' | 'member' | 'viewer'; email: string };
/** The context a tool gets from the registry. */
const ctxOf = (auth: Auth, logged: string[]) => ({ user: { email: auth.email, role: auth.role }, auth, config: undefined, state: {} as never, log: (...a: unknown[]) => void logged.push(a.join(' ')) });
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

test('an excerpt is the stretch that holds the most words of the search, and lists merge by rank', () => {
  const text = `${'filler words here. '.repeat(40)}The rollback uses the previous image tag. ${'more filler. '.repeat(40)}`;
  const e = excerpt(text, ['rollback', 'image'], 120);
  assert.ok(e.includes('rollback') && e.includes('image'), e);
  assert.ok(e.startsWith('… ') && e.endsWith(' …'), e);
  assert.equal(excerpt('short text', ['x'], 100), 'short text');
  assert.ok(excerpt(text, ['absent'], 80).startsWith('filler'), 'the start when no word is there');
  assert.deepEqual(fuseRanks([['a', 'b', 'c'], ['b', 'c']]), ['b', 'c', 'a']);
});

test('searches, reads and reports: the documents come back by their IDs, best first, with what they hold', async () => {
  const m = await model((b) => {
    const done = toolResults(b).length;
    if (done === 0) return { calls: [{ name: 'search', args: { query: 'deploy main branch' } }] };
    if (done === 1) return { calls: [{ name: 'read', args: { doc: 'd1' } }, { name: 'search', args: { query: 'roll back previous image' } }] };
    return { calls: [{ name: 'report', args: { documents: [{ doc: 'd1', why: 'how deploys go out' }, { doc: 'd2', why: 'how to roll back' }] } }] };
  });
  const r = await asOwner(() => agentSearch('Where do production deploys come from, and what if one breaks?'));
  assert.equal(m.seen.length, 3, 'nothing is asked after the report');
  // The question as asked was searched first, and the model was shown what it found.
  assert.match(String(m.seen[0].messages[1].content), /^Question: Where do production deploys come from[^\n]*\n\nWhat a search for the question as asked found:\n\n2 documents for [^\n]*\n\nd1 · docs\/ops\/deploy\.md/);
  assert.deepEqual(
    r.documents.map((d) => [d.id, d.why, d.reported]),
    [
      ['local:docs/ops/deploy.md', 'how deploys go out', true],
      ['local:docs/ops/rollback.md', 'how to roll back', true],
    ],
  );
  assert.deepEqual([r.searches, r.reads, r.agents, r.rounds, r.model, r.note], [3, 1, 1, 3, 'fake-model', null]);
  assert.deepEqual(r.trace, [{ judged: ['local:docs/ops/deploy.md', 'local:docs/ops/rollback.md'], seed: ['local:docs/ops/deploy.md', 'local:docs/ops/rollback.md'], searched: ['local:docs/ops/deploy.md', 'local:docs/ops/rollback.md'] }]);
  assert.equal(m.seen[0].max_tokens, 8000, 'an answer that runs on is cut');
  // The model reads documents by short names, not their IDs, and is told how many rounds are left.
  const results = toolResults(m.seen[2]);
  assert.match(results[0], /^1 document for "deploy main branch":\n\nd1 · docs\/ops\/deploy\.md/);
  assert.match(results[0], /\(5 rounds left\.\)$/);
  assert.match(results[1], /^# deploy\.md\nd1 · /);
  assert.ok(!results.join('\n').includes('local:'), 'no ID is shown to the model');
  assert.match(String(m.seen[0].messages[0].content), /You have 6 rounds of tool calls/);
  assert.deepEqual(m.seen[0].tools?.map((t) => t.function.name), ['search', 'read', 'report']);

  // As an assistant reads it.
  const text = render(r);
  assert.match(text, /^# Documents for "Where do production deploys come from, and what if one breaks\?"\n2 documents, all judged to answer, found by fake-model: 3 searches, 1 read, 2 documents looked at/);
  assert.match(text, /\n1\. deploy\.md — modified \d{4}-\d\d-\d\d\n {3}ID: `local:docs\/ops\/deploy\.md`\n {3}Holds: how deploys go out\n/);
});

test('a report of documents no search showed is refused, and an assistant that stops early still leaves what it saw', async () => {
  const m = await model((b) => {
    const done = toolResults(b).length;
    if (done === 0) return { calls: [{ name: 'search', args: { query: 'previous image registry' } }] };
    if (done === 1) return { calls: [{ name: 'report', args: { documents: [{ doc: 'd7', why: 'made up' }] } }] };
    return { text: 'The rollback redeploys the previous image.' };
  });
  const r = await asOwner(() => agentSearch('How do we roll back?', { effort: 'low' }));
  assert.match(toolResults(m.seen[2]).at(-1)!, /^Error: d7: no search showed this document/);
  assert.deepEqual(r.documents.map((d) => [d.id, d.reported]), [['local:docs/ops/rollback.md', false]]);
  assert.match(r.note ?? '', /stopped without judging what it found/);
  assert.match(render(r), /\n1 document, none judged to answer, found by fake-model[^\n]*\n> [^\n]*\n\n1\. rollback\.md — [^\n]*\n {3}ID: `local:docs\/ops\/rollback\.md`\n {3}Not judged: shown by its searches$/);
  // The last round offered the report alone.
  assert.deepEqual([m.seen[1].tools?.length, m.seen[2].tools?.map((t) => t.function.name)], [3, ['report']]);
  assert.match(String(m.seen[0].messages[0].content), /You have 3 rounds/);
  // Told once to hand in its result, then let go.
  assert.equal(m.seen.length, 4);
  assert.match(String(m.seen[3].messages.at(-1)?.content), /^Hand in your result with the report tool/);
});

test('a model that answers nothing is reminded without an empty turn', async () => {
  const m = await model((b) => {
    if (toolResults(b).length === 0 && !b.messages.some((x) => String(x.content ?? '').startsWith('Hand in'))) return { text: '' };
    return { calls: [{ name: 'report', args: { documents: [] } }] };
  });
  const r = await asOwner(() => agentSearch('Where do production deploys come from?'));
  assert.equal(m.seen.length, 2);
  // The reminder follows the question directly: no assistant turn without content (Ollama refuses it).
  assert.deepEqual(m.seen[1].messages.map((x) => [x.role, x.content === null ? null : typeof x.content]), [['system', 'string'], ['user', 'string'], ['user', 'string']]);
  assert.equal(r.note, null);
});

test('a model that fails after it searched leaves what its searches found', async () => {
  await model((b) => (toolResults(b).length === 0 ? { calls: [{ name: 'search', args: { query: 'previous image registry' } }] } : { fail: true }));
  const r = await asOwner(() => agentSearch('What do we do when a release breaks?'));
  assert.deepEqual(r.documents.map((d) => [d.id, d.reported]), [['local:docs/ops/rollback.md', false]]);
  assert.match(r.note ?? '', /^The model failed before it finished\. The assistant stopped without judging/);
  assert.ok(!(r.note ?? '').includes('127.0.0.1'), 'the model\'s address is not in the note');
  // Failing at once, before any search of its own, is a failure.
  await model(() => ({ fail: true }));
  await assert.rejects(asOwner(() => agentSearch('What do we do when a release breaks?')), /answered 500/);
});

test('the folders a person may see bound what the assistant sees', async () => {
  const m = await model((b) => {
    const done = toolResults(b).length;
    if (done === 0) return { calls: [{ name: 'search', args: { query: 'deploy main branch' } }] };
    if (done === 1) return { calls: [{ name: 'read', args: { doc: 'local:docs/ops/deploy.md' } }] };
    return { calls: [{ name: 'report', args: { documents: [] } }] };
  });
  const member = { ok: true, org_id: 'default', role: 'member' as const, email: 'm@example.com', scopes: { driveFolders: ['docs/hr'] } };
  const r = await authStore.run(member, () => agentSearch('How do we deploy?'));
  const said = toolResults(m.seen[2]).join('\n');
  assert.match(said, /Nothing found for "deploy main branch"/);
  assert.match(said, /There is no document local:docs\/ops\/deploy\.md here/);
  assert.ok(!said.includes('main branch after one review'), 'nothing outside the folders reaches the model');
  assert.deepEqual(r.documents, []);
  assert.match(render(r), /found no document that answers this/);
});

test('high effort splits the question, searches the parts at once, and merges what they report', async () => {
  const m = await model((b) => {
    if (!b.stream) return { text: 'PART: deploy main branch\nPART: previous image registry' };
    const part = /Your part of it: (.+)/.exec(String(b.messages.find((x) => x.role === 'user')?.content))?.[1] ?? '';
    if (toolResults(b).length === 0) return { calls: [{ name: 'search', args: { query: part } }] };
    return { calls: [{ name: 'report', args: { documents: [{ doc: 'd1', why: part }] } }] };
  });
  const r = await asOwner(() => agentSearch('How do we deploy, and how do we roll back?', { effort: 'high' }));
  assert.deepEqual(r.parts, ['deploy main branch', 'previous image registry']);
  assert.equal(r.agents, 2);
  assert.deepEqual(r.documents.map((d) => d.id).sort(), ['local:docs/ops/deploy.md', 'local:docs/ops/rollback.md']);
  assert.equal(m.seen.filter((b) => b.stream).length, 4);
  assert.match(render(r), /2 assistants at once \("deploy main branch", "previous image registry"\)/);
});

test('find_documents is listed only while a model is connected for it, and says what failed', async () => {
  for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL']) delete process.env[k];
  assert.equal(findDocumentsTool.enabled?.(), 'connect a language model on the Models page');
  // A model of its own for search is enough.
  Object.assign(process.env, { SEARCH_LLM_PROVIDER: 'openai', SEARCH_LLM_BASE_URL: 'http://127.0.0.1:9/v1', SEARCH_LLM_MODEL: 'small' });
  assert.equal(findDocumentsTool.enabled?.(), true);
  const logged: string[] = [];
  const r = await asOwner(async () => findDocumentsTool.run({ question: 'deploy?', effort: 'low', limit: 5 }, ctxOf(owner, logged)));
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.match(textOf(r), /^\[error\] .*127\.0\.0\.1:9 could not be reached.*search_knowledge still works without it\.$/);
  // Anyone else hears that it failed, not where the model is. The owner finds the reason in the log.
  const member = { ok: true, org_id: 'default', role: 'member' as const, email: 'm@example.com' };
  const other = await authStore.run(member, async () => findDocumentsTool.run({ question: 'deploy?', effort: 'low', limit: 5 }, ctxOf(member, logged)));
  assert.equal(textOf(other), '[error] The search assistant could not search right now. search_knowledge still works without it.');
  assert.ok(logged.some((l) => l.includes('127.0.0.1:9')));
  for (const k of ['SEARCH_LLM_PROVIDER', 'SEARCH_LLM_BASE_URL', 'SEARCH_LLM_MODEL']) delete process.env[k];
});

test('what one assistant and one person can make the server do is bounded', async () => {
  // Eight searches in one round: six run. A part below 1 reads the first. A report sent as a string is read.
  const m = await model((b) => {
    const done = toolResults(b).length;
    if (done === 0) return { calls: Array.from({ length: 8 }, (_, i) => ({ name: 'search', args: { query: i % 2 ? 'roll back previous image' : 'deploy main branch' } })) };
    if (done === 8) return { calls: [{ name: 'read', args: { doc: aliasIn(b, 'docs/ops/rollback.md'), part: -1 } }] };
    if (done === 9) return { calls: [{ name: 'report', args: { documents: { doc: 'd1' } } }] };
    return { calls: [{ name: 'report', args: { documents: JSON.stringify([{ doc: aliasIn(b, 'docs/ops/rollback.md'), why: 'rollback' }, { doc: aliasIn(b, 'docs/ops/deploy.md'), why: 'deploy' }]) } }] };
  });
  const r = await asOwner(() => agentSearch('How do we deploy and roll back?'));
  const said = toolResults(m.seen.at(-1)!);
  assert.deepEqual(said.slice(6, 8), ['Error: At most 6 calls in one round: this one was not run.', 'Error: At most 6 calls in one round: this one was not run.']);
  assert.equal(r.searches, 7, 'the question as asked, and six of the eight');
  assert.match(said[8], /^# rollback\.md\nd\d · modified [\d-]+ · part 1 of 1/);
  assert.match(said[9], /^Error: documents must be a list/);
  assert.deepEqual(r.documents.map((d) => [d.id, d.why]), [['local:docs/ops/rollback.md', 'rollback'], ['local:docs/ops/deploy.md', 'deploy']]);

  // One person: two questions at once, not a third. A slow model keeps the first two busy.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  await model((b) => (toolResults(b).length === 0 ? { calls: [{ name: 'report', args: { documents: [] } }] } : { text: '' }));
  const slow = createServer(async (_req, res) => {
    await gate;
    res.writeHead(500).end();
  });
  fakes.push(slow);
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`;
  const ask = () => asOwner(async () => findDocumentsTool.run({ question: 'deploy?', effort: 'low', limit: 5 }, ctxOf(owner, [])));
  const first = [ask(), ask()];
  await new Promise((r) => setTimeout(r, 50));
  assert.match(textOf(await ask()), /^\[error\] You have 2 questions with the search assistant already/);
  release();
  await Promise.all(first);

  // A call the client cancelled stops; progress goes to a client that asked for it.
  await model((b) => (toolResults(b).length === 0 ? { calls: [{ name: 'search', args: { query: 'deploy' } }] } : { calls: [{ name: 'report', args: { documents: ['d1'] } }] }));
  const told: string[] = [];
  const done = await asOwner(async () => findDocumentsTool.run({ question: 'deploy?', effort: 'low', limit: 5 }, { ...ctxOf(owner, []), progress: (n: number, msg?: string) => told.push(`${n} ${msg}`) }));
  assert.match(textOf(done), /1\. deploy\.md/);
  assert.deepEqual(told, ['1 searched for "deploy"', '2 reported']);
  const cancelled = await asOwner(async () => findDocumentsTool.run({ question: 'deploy?', effort: 'low', limit: 5 }, { ...ctxOf(owner, []), signal: AbortSignal.abort() }));
  assert.equal((cancelled as { isError?: boolean }).isError, true);
});

test('measuring: several right documents count by place, and the search assistant is measured beside search', async () => {
  // Two right documents, found first and third: NDCG (1 + 1/2) / (1 + 1/log2 3), recall 1.
  const s = scoreOf([{ ranks: [1, 3], wanted: 2 }, 0, 2]);
  assert.deepEqual([s.first, s.top3, s.top10], [1, 2, 2]);
  assert.equal(s.ndcg, Math.round((((1 + 0.5) / (1 + 1 / Math.log2(3)) + 0 + 1 / Math.log2(3)) / 3) * 1000) / 1000);
  assert.equal(s.recall, Math.round((2 / 3) * 1000) / 1000);
  assert.deepEqual(placeOf(['ops/'], [{ id: 'a', path: 'hr/x.md' }, { id: 'b', path: 'ops/y.md' }, { id: 'b', path: 'ops/y.md' }]).ranks, [2]);
  // A target that matches several documents counts once; a missing target counts as missing.
  const many = placeOf(['ops/', 'hr/x.md'], [{ id: 'a', path: 'ops/a.md' }, { id: 'b', path: 'ops/b.md' }]);
  assert.deepEqual(many.ranks, [1]);
  assert.deepEqual([scoreOf([many]).recall, scoreOf([placeOf(['ops/'], [{ id: 'a', path: 'ops/a.md' }, { id: 'b', path: 'ops/b.md' }])]).ndcg], [0.5, 1]);

  await model((b) => (toolResults(b).length === 0 ? { calls: [{ name: 'search', args: { query: 'previous image' } }] } : { calls: [{ name: 'report', args: { documents: [{ doc: 'd1', why: 'rollback' }] } }] }));
  // From the console or a terminal there is no caller: the owner of this machine measures.
  const r = await scoreQuestions([{ question: 'What returns us to the earlier release?', document: 'ops/rollback.md' }], undefined, undefined, { agent: 'low' });
  assert.equal(r.modes.agent?.first, 1);
  assert.deepEqual([r.agent?.model, r.agent?.effort, r.agent?.searches], ['fake-model', 'low', 2]);
  assert.equal(r.modes.both?.top10, 0, 'the words of the question are not in the document');
});
