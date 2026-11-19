/**
 * The wiki a connected model writes from the documents: one page per document, one per topic with every fact
 * tied to its document, an index and a log. The model here is a local fake that answers from the text it is
 * given, so the pages can be checked word for word and nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|WIKI_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-wiki-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
const put = (name: string, text: string, at?: Date) => {
  writeFileSync(join(docs, name), text);
  if (at) utimesSync(join(docs, name), at, at);
};
// Each line "Topic: a fact." is what the fake model takes from a document.
put('handbook.md', '# Handbook\n\nVacation: Everyone has 25 days of vacation.\nVacation: Unused days carry over until March.\nOffsite: The offsite is in May.\n', new Date('2026-01-10T00:00:00Z'));
put('travel.md', '# Travel policy\n\nVacation: Travel days around a vacation are not working days.\nExpenses: Receipts are handed in within 30 days.\n', new Date('2026-01-11T00:00:00Z'));
put('broken.md', '# Broken\n\nBROKEN\n', new Date('2026-01-12T00:00:00Z'));
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
Object.assign(process.env, { MCP_STORE: 'sqlite', MCP_DATA_DIR: join(dir, 'data'), MCP_CONFIG_PATH: join(dir, 'mcp.config.json'), MCP_ENV_FILE: 'none', KMCP_SUPERVISE: 'false', KNOWLEDGE_CONSOLE: 'on', KNOWLEDGE_SCAN_ENABLED: 'false', PORT: '0' });

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { readAnswer, partsOf, pageName, topicKey, readWikiState } = await import('../src/plugins/knowledge/wiki.js');

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
const wiki = join(dir, 'wiki');
const page = (...parts: string[]) => readFileSync(join(wiki, ...parts), 'utf8');

/** A model that reads what it is given: "Topic: fact." lines become topics and facts, a heading becomes the title. */
const model = { calls: [] as Array<{ system: string; prompt: string }>, delay: 0 };
const llm = createServer((req: IncomingMessage, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer test-key-000000') return void res.writeHead(401).end(JSON.stringify({ error: { message: 'no' } }));
    const body = JSON.parse(raw);
    const system = body.messages[0].content as string;
    const prompt = body.messages.at(-1).content as string;
    model.calls.push({ system, prompt });
    if (model.delay) await new Promise((r) => setTimeout(r, model.delay));
    let text: string;
    if (system.startsWith('You write the opening')) {
      const topic = /^Topic: (.+)$/m.exec(prompt)![1];
      text = `<think>three facts</think>What the documents say about ${topic}, from ${prompt.split('\n- ').length - 1} facts.`;
    } else if (prompt.includes('BROKEN')) {
      text = 'I am sorry, I cannot find anything to summarize here.';
    } else {
      const document = prompt.slice(prompt.indexOf('\n---\n') + 5, prompt.lastIndexOf('\n---'));
      const title = /^# (.+)$/m.exec(document)?.[1] ?? 'Untitled';
      const lines = [`TITLE: ${title}`, `SUMMARY: What ${title} says.`];
      const topics = new Map<string, string[]>();
      for (const m of document.matchAll(/^([A-Z][A-Za-z ]+): (.+)$/gm)) topics.set(m[1], [...(topics.get(m[1]) ?? []), m[2]]);
      for (const [, facts] of topics) lines.push(`POINT: ${facts[0]}`);
      // As small models do: a bullet here, bold there.
      for (const [name, facts] of topics) lines.push(`- **TOPIC:** ${name}`, 'KIND: concept', `DEFINITION: What ${name} means here.`, ...facts.map((f) => `* FACT: ${f}`));
      text = lines.join('\n');
    }
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
});
await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
fakes.push(llm);
const connect = (key = 'test-key-000000') => Object.assign(process.env, { LLM_PROVIDER: 'openai', LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, LLM_API_KEY: key, LLM_MODEL: 'small-model' });
/** Start a run and wait for it to end. */
const runWiki = async (body: object = {}) => {
  const started = await api('POST', '/wiki/run', body);
  assert.equal(started.status, 200, started.text);
  for (let i = 0; i < 400; i++) {
    const s = (await api('GET', '/wiki')).json;
    if (!s.run.running) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run did not end');
};

test('what the model answers is read whatever it is wrapped in', () => {
  const plain = readAnswer('TITLE: Plan\nSUMMARY: A plan.\nPOINT: One.\nTOPIC: Budget\nKIND: entity\nDEFINITION: The money.\nFACT: It is 10.\nFACT: It was 8.\nTOPIC: Team\nFACT: Five people.');
  assert.deepEqual(plain, { title: 'Plan', summary: 'A plan.', points: ['One.'], topics: [{ title: 'Budget', kind: 'entity', definition: 'The money.', facts: ['It is 10.', 'It was 8.'] }, { title: 'Team', kind: 'concept', definition: '', facts: ['Five people.'] }] });
  // Reasoning first, bullets, bold, another colon, a line of chatter: the same.
  const dressed = readAnswer('<think>{"not": "this"}</think>\nHere you go:\n- **TITLE:** Plan\n> SUMMARY： A plan.\n* POINT: One.\n## TOPIC: Budget\nKIND: Entity\nDEFINITION: The money.\n- FACT: It is 10.\n- FACT: It was 8.\nTOPIC: Team\nFACT: Five people.\nHope this helps!');
  assert.deepEqual(dressed, plain);
  // A model that answered in JSON after all is read as JSON. Nothing readable is said, not guessed at.
  assert.deepEqual(readAnswer('```json\n{"title":"Plan","summary":"A plan.","points":[],"topics":[]}\n```'), { title: 'Plan', summary: 'A plan.', points: [], topics: [] });
  assert.throws(() => readAnswer('I cannot help with that.'), /no labelled line/);
  // A fact before any topic belongs to nothing and is left out.
  assert.deepEqual(readAnswer('TITLE: T\nFACT: stray').topics, []);

  // A long document goes to the model in parts, cut at a paragraph, and what is left over is said.
  const long = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(90)}`).join('\n\n');
  const cut = partsOf(long, { partChars: 320, maxParts: 2 });
  assert.deepEqual([cut.parts.length, cut.partial, cut.parts.every((p) => p.length <= 320 && p.startsWith('Paragraph'))], [2, true, true]);
  assert.deepEqual(partsOf('short', { partChars: 320, maxParts: 2 }), { parts: ['short'], partial: false });

  // Names: what a file or a [[link]] cannot hold is taken out, and wordings of one topic meet.
  assert.deepEqual([pageName('  A/B: [x] #1?  '), pageName('...'), topicKey('Client SDK'), topicKey('client-sdk'), topicKey('Client_SDK ')], ['A B x 1', 'Untitled', 'client sdk', 'client sdk', 'client sdk']);
});

test('the wiki is made as a folder of this server, and read into only with a model connected', async () => {
  assert.deepEqual((await api('GET', '/wiki')).json, { exists: false, path: wiki, documents: 0, topics: 0, waiting: 0, gone: 0, run: null, model: false });
  assert.equal((await api('POST', '/wiki/run', {})).status, 409);

  const made = await api('POST', '/wiki');
  assert.deepEqual([made.status, made.json.restartNeeded], [200, true], made.text);
  assert.deepEqual(readdirSync(wiki).sort(), ['AGENTS.md', 'index.md', 'log.md', 'sources', 'topics']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).folders.at(-1), { path: wiki, name: 'wiki' });
  // The rules are the person's to change: making the wiki again writes over nothing.
  writeFileSync(join(wiki, 'AGENTS.md'), `${page('AGENTS.md')}\n## Ours\n\nCall the offsite a retreat.\n`);
  assert.equal((await api('POST', '/wiki')).status, 200);
  assert.match(page('AGENTS.md'), /Call the offsite a retreat\./);

  const waiting = (await api('GET', '/wiki')).json;
  assert.deepEqual([waiting.exists, waiting.waiting, waiting.model], [true, 3, false]);
  const refused = await api('POST', '/wiki/run', {});
  assert.deepEqual([refused.status, /No model is connected/.test(refused.json.error)], [409, true]);
});

test('reading: a page per document, a page per topic with each fact tied to its document, an index and a log', async () => {
  connect();
  const s = await runWiki({ limit: 10 });
  assert.deepEqual([s.run.done, s.run.total, s.run.stopped, s.documents, s.topics, s.waiting], [3, 3, null, 2, 3, 1]);
  // One document the model said nothing usable about: said, with why, and the others are read all the same.
  assert.deepEqual(s.run.failed.map((f: any) => [f.document, /did not answer in the shape asked for/.test(f.why)]), [['docs/broken.md', true]]);
  // 2 questions for the two readable documents, 2 tries for the unreadable one, 1 for the topic with three facts.
  assert.deepEqual([s.run.usage.calls, s.run.written, s.run.usage.input], [5, 1, 500]);

  // The model was given the rules as they are now, and the topics the wiki already has.
  assert.ok(model.calls.every((c) => c.system.includes('Call the offsite a retreat.')));
  const second = model.calls.find((c) => c.prompt.includes('Document: docs/travel.md'))!;
  assert.match(second.prompt, /Topics already in the wiki[^]*- Vacation\n- Offsite/);

  assert.deepEqual(readdirSync(join(wiki, 'sources')).sort(), ['docs - handbook.md', 'docs - travel.md']);
  assert.deepEqual(readdirSync(join(wiki, 'topics')).sort(), ['Expenses.md', 'Offsite.md', 'Vacation.md']);
  const handbook = page('sources', 'docs - handbook.md');
  assert.match(handbook, /^---\ntype: source\ndocument: "local:docs\/handbook\.md"\nmodified: "2026-01-10T00:00:00\.000Z"\nupdated: \d{4}-\d\d-\d\d\n---\n# Handbook\n\n> What Handbook says\.\n\nThe document: \[docs\/handbook\.md\]\(docs\/handbook\.md\)\n/);
  assert.match(handbook, /## Key points\n- Everyone has 25 days of vacation\.\n- The offsite is in May\.\n\n## Topics\n- \[\[Vacation\]\]\n- \[\[Offsite\]\]\n$/);

  // A topic gathers what both documents say, each fact with where it comes from, and names its neighbours.
  const vacation = page('topics', 'Vacation.md');
  assert.match(vacation, /^---\ntype: topic\nkind: concept\ndocuments: 2\n/);
  assert.match(vacation, /# Vacation\n\n> What Vacation means here\.\n\nWhat the documents say about Vacation, from 3 facts\.\n\n## What the documents say\n/);
  assert.match(vacation, /- Everyone has 25 days of vacation\. \(\[\[docs - handbook\|Handbook\]\]\)\n- Unused days carry over until March\. \(\[\[docs - handbook\|Handbook\]\]\)\n- Travel days around a vacation are not working days\. \(\[\[docs - travel\|Travel policy\]\]\)\n/);
  assert.match(vacation, /## Related\n- \[\[Expenses\]\]\n- \[\[Offsite\]\]\n$/);
  assert.ok(!vacation.includes('<think>'));
  // Fewer than three facts: no opening is asked for.
  assert.ok(!page('topics', 'Offsite.md').includes('What the documents say about'));

  assert.match(page('index.md'), /^# Index\n\n3 topics from 2 documents\./);
  assert.match(page('index.md'), /## Topics\n- \[\[Expenses\]\]: What Expenses means here\.\n- \[\[Offsite\]\]: [^\n]+\n- \[\[Vacation\]\]: [^\n]+\n\n## Documents\n- \[\[docs - handbook\|Handbook\]\]: What Handbook says\.\n- \[\[docs - travel\|Travel policy\]\]: What Travel policy says\.\n/);
  assert.match(page('log.md'), /## \[\d{4}-\d\d-\d\d\] read \| docs\/handbook\.md → 2 topics\n## \[\d{4}-\d\d-\d\d\] read \| docs\/travel\.md → 2 topics\n$/);
});

test('a second run reads only what changed, keeps the person\'s notes, and takes away what is gone', async () => {
  // The person writes on a page. A document changes, one is taken away, and the one that could not be read is mended.
  writeFileSync(join(wiki, 'topics', 'Vacation.md'), `${page('topics', 'Vacation.md')}\n## Notes\n\nAsk HR about half days.\n`);
  put('travel.md', '# Travel policy\n\nVacation: Travel days count as working days from 2027.\nExpenses: Receipts are handed in within 30 days.\n', new Date('2026-02-01T00:00:00Z'));
  put('broken.md', '# Mended\n\nOffsite: The offsite moved to June.\n', new Date('2026-02-02T00:00:00Z'));
  rmSync(join(docs, 'handbook.md'));
  assert.deepEqual([(await api('GET', '/wiki')).json.waiting, (await api('GET', '/wiki')).json.gone], [2, 1]);

  const before = model.calls.length;
  const s = await runWiki({ limit: 10 });
  assert.deepEqual([s.run.done, s.run.total, s.run.failed, s.documents, s.topics, s.waiting, s.gone], [2, 2, [], 2, 3, 0, 0]);
  assert.equal(model.calls.length - before, 2, 'only the two changed documents were read');

  // What the removed document said is gone from every page, and so is its own page.
  assert.deepEqual(readdirSync(join(wiki, 'sources')).sort(), ['docs - broken.md', 'docs - travel.md']);
  const vacation = page('topics', 'Vacation.md');
  assert.ok(!vacation.includes('25 days') && !vacation.includes('not working days'));
  assert.match(vacation, /- Travel days count as working days from 2027\. \(\[\[docs - travel\|Travel policy\]\]\)\n/);
  // The opening was written from facts that are no longer there: it is not shown as if it still held.
  assert.ok(!vacation.includes('What the documents say about Vacation'));
  assert.match(vacation, /\n## Notes\n\nAsk HR about half days\.\n$/);
  assert.match(page('topics', 'Offsite.md'), /- The offsite moved to June\. \(\[\[docs - broken\|Mended\]\]\)/);
  assert.match(page('log.md'), /## \[\d{4}-\d\d-\d\d\] gone \| docs\/handbook\.md\n/);
  assert.deepEqual(Object.keys(readWikiState().sources).sort(), ['local:docs/broken.md', 'local:docs/travel.md']);

  // Nothing changed: nothing is asked of the model.
  const idle = model.calls.length;
  const again = await runWiki({});
  assert.deepEqual([again.run.total, model.calls.length - idle], [0, 0]);
});

test('a run stops where going on is no use, and when the person stops it', async () => {
  put('a.md', '# A\n\nAlpha: One.\n', new Date('2026-03-01T00:00:00Z'));
  put('b.md', '# B\n\nBeta: Two.\n', new Date('2026-03-02T00:00:00Z'));
  put('c.md', '# C\n\nGamma: Three.\n', new Date('2026-03-03T00:00:00Z'));
  // The key is refused: the next document would fail the same way, so it is not tried.
  connect('wrong-key-000000');
  const refused = await runWiki({});
  assert.deepEqual([refused.run.done, refused.run.total, /did not accept the API key/.test(refused.run.stopped), refused.waiting], [0, 3, true, 3]);

  // Stopped by the person in the middle: what was read is kept, the rest waits.
  connect();
  model.delay = 150;
  assert.equal((await api('POST', '/wiki/run', {})).status, 200);
  await new Promise((r) => setTimeout(r, 220));
  assert.equal((await api('POST', '/wiki/stop')).status, 200);
  let s: any;
  for (let i = 0; i < 200; i++) {
    s = (await api('GET', '/wiki')).json;
    if (!s.run.running) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  model.delay = 0;
  assert.match(s.run.stopped, /^Stopped\. What was read so far is kept\.$/);
  assert.ok(s.run.done >= 1 && s.run.done < 3 && s.waiting === 3 - s.run.done, JSON.stringify(s.run));
  assert.ok(existsSync(join(wiki, 'sources', 'docs - a.md')));
});
