/**
 * Notes and conversations kept on this machine: save_note writes into notes/ (the console) or inbox/<who>/ (anyone
 * else), POST /inbox takes a note from a program with a key, and the console's conversations are kept and picked up
 * again. The model is a local fake that streams as an OpenAI-compatible endpoint does: nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|SEARCH_LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_|CHAT_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-notes-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
writeFileSync(join(docs, 'lecture-3.md'), '# Lecture 3\n\nPhotosynthesis turns light into chemical energy in the chloroplast.\n');
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ orgId: 'acme', folders: [{ path: docs, name: 'docs' }] }));

/** A model that streams one answer and keeps what it was sent. */
const seen: Array<{ messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> }> = [];
const slow = { ms: 0 };
const llm = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    seen.push(JSON.parse(raw));
    if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ model: 'fake', choices: [{ index: 0, delta: { content: `Answer ${seen.length}.` }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
  LLM_PROVIDER: 'openai',
  LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
  LLM_MODEL: 'fake',
});

const { getStore } = await import('../src/store/index.js');
const store = await getStore();
await store.upsertUser({ email: 'member@acme.com', role: 'member' });
await store.upsertUser({ email: 'other@acme.com', role: 'member' });
const memberKey = (await store.createKey({ email: 'member@acme.com', orgId: 'acme' })).key;
const viewerKey = (await store.createKey({ email: 'stranger@acme.com', orgId: 'acme' })).key;

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { scanFolders, scanFoldersSoon } = await import('../src/plugins/knowledge/folders.js');
const { writeChat, readChat, historyOf, listChats, newChat, deleteChat } = await import('../src/admin/chats.js');

await scanFolders();
const registry = new Registry(builtinPlugins);
const server = await runHttp(registry);
const base = `http://localhost:${server.port}`;
const token = consoleToken();
after(async () => {
  llm.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ndjson or empty */
  }
  return { status: res.status, json, text };
};
const run = async (name: string, args: unknown) => (await api('POST', '/run', { name, args })).json as { ok: boolean; text: string };
const today = new Date().toISOString().slice(0, 10);

test('the console saves notes into notes/: never over another file, replaced only there, searched at once', async () => {
  const first = await run('save_note', { title: 'Lecture 3: photosynthesis', content: '- Light becomes chemical energy.\n- It happens in the chloroplast.', tags: ['biology'] });
  assert.equal(first.ok, true, first.text);
  const name = `${today} Lecture 3 photosynthesis.md`;
  assert.match(first.text, new RegExp(`^Saved: notes/${name.replace(/[.()]/g, '\\$&')}\\.`));
  const file = join(dir, 'notes', name);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---\ntitle: "Lecture 3: photosynthesis"\ndate: \d{4}-\d\d-\d\d\nupdated: \d{4}-\d\d-\d\d\ntags: \["biology"\]\nfrom: "console"\n---\n# Lecture 3: photosynthesis\n\n- Light becomes/);

  // The same title again the same day: a second note, not the first one written over.
  assert.match((await run('save_note', { title: 'Lecture 3: photosynthesis', content: 'Again.' })).text, /^Saved: notes\/.* \(2\)\.md/);
  // Replaced by its path, and only a note there.
  const replaced = await run('save_note', { title: 'Lecture 3: photosynthesis', content: '# Mine\n\nRewritten.', path: name });
  assert.match(replaced.text, /^Replaced: notes\//);
  assert.match(readFileSync(file, 'utf8'), /\n# Mine\n\nRewritten\.\n$/);
  // What it said before is kept, out of sight of search.
  const versions = readdirSync(join(dir, 'notes', '.versions'));
  assert.equal(versions.length, 1);
  assert.match(readFileSync(join(dir, 'notes', '.versions', versions[0]), 'utf8'), /Light becomes chemical energy/);
  // A link in notes/ leads elsewhere (here: to the documents): nothing is written through it.
  symlinkSync(docs, join(dir, 'notes', 'vault'));
  const linked = await run('save_note', { title: 'x', content: 'Overwritten', path: 'vault/lecture-3.md' });
  assert.deepEqual([linked.ok, /vault is a link/.test(linked.text)], [false, true], linked.text);
  assert.ok(!readFileSync(join(docs, 'lecture-3.md'), 'utf8').includes('Overwritten'));
  for (const path of ['../docs/lecture-3.md', '/etc/hosts', 'nothing-here.md', `../notes/${name}`.replace('notes', 'docs')]) {
    const refused = await run('save_note', { title: 'x', content: 'x', path });
    assert.equal(refused.ok, false, path);
    assert.match(refused.text, /There is no note of yours at .* in notes\/ to replace/);
  }
  assert.equal(readFileSync(join(docs, 'lecture-3.md'), 'utf8').includes('Rewritten'), false, 'the documents are not changed');

  // notes/ is a folder of this server without being configured: the note is found by search. (Saving started a
  // pass already; this waits for it and reads again.)
  await scanFoldersSoon();
  const found = await run('search_knowledge', { query: 'Rewritten' });
  assert.match(found.text, /ID: `local:notes\//);
});

test('another caller saves into inbox/<who>/, and a viewer may not save', async () => {
  const member = { ok: true, org_id: 'acme', role: 'member' as const, email: 'member@acme.com' };
  const r = await registry.call('save_note', { title: 'From Claude', content: 'Found on the web.' }, member);
  assert.match(String((r.content[0] as unknown as { text: string }).text), new RegExp(`^Saved: inbox/member/${today} From Claude\\.md`));
  assert.ok(existsSync(join(dir, 'inbox', 'member', `${today} From Claude.md`)));
  // Another caller cannot replace it: a path is inside the caller's own folder.
  const other = { ok: true, org_id: 'acme', role: 'member' as const, email: 'other@acme.com' };
  for (const path of [`member/${today} From Claude.md`, `../member/${today} From Claude.md`]) {
    const r2 = await registry.call('save_note', { title: 'x', content: 'Taken over', path }, other);
    assert.equal(r2.isError, true, path);
  }
  assert.ok(!readFileSync(join(dir, 'inbox', 'member', `${today} From Claude.md`), 'utf8').includes('Taken over'));
  // inbox/ is searched, but not written up in the wiki as if the person's documents said it.
  const { wikiDocuments } = await import('../src/plugins/knowledge/wiki.js');
  assert.ok(!(await wikiDocuments(dir)).some((d) => d.id.startsWith('local:inbox/')));
  const viewer = await registry.call('save_note', { title: 'x', content: 'x' }, { ok: true, org_id: 'acme', role: 'viewer', email: 'v@acme.com' });
  assert.deepEqual([viewer.isError, (viewer.content[0] as unknown as { text: string }).text], [true, '[error] A viewer may not save notes.']);
});

test('POST /inbox takes a note from a program with a key: a member, not a viewer, and nothing without a key', async () => {
  const send = (key: string | null, body: unknown) =>
    fetch(`${base}/inbox`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const note = { title: 'Course page, week 4', content: 'Assignment 2 is due on Friday.', from: 'Aside', url: 'https://school.example/course/week-4' };
  assert.equal((await send(null, note)).status, 401);
  assert.equal((await send(viewerKey, note)).status, 403);
  const bad = await send(memberKey, { title: '', content: 'x' });
  assert.equal(bad.status, 400);
  const ok = await send(memberKey, note);
  assert.equal(ok.status, 201);
  // The folder is who sent it (the key's owner); what the note says it is from is kept as `via`.
  assert.deepEqual(await ok.json(), { saved: `inbox/member/${today} Course page, week 4.md` });
  assert.match(readFileSync(join(dir, 'inbox', 'member', `${today} Course page, week 4.md`), 'utf8'), /from: "member"\nvia: "Aside"\nsource: "https:\/\/school\.example\/course\/week-4"\n---/);
  // A failure on the server says nothing of where its files are.
  const broken = await send(memberKey, { title: 'bad\u0000name', content: 'x' });
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: 'The note could not be saved on the server.' });
});

test('conversations are kept, picked up again with what was said, and removed', async () => {
  assert.ok((await api('GET', '/chat')).json.tools.includes('save_note'), 'the chat may keep notes');
  const ask = async (body: object) => (await api('POST', '/chat', body)).text.trim().split('\n').map((l) => JSON.parse(l));
  const one = await ask({ message: 'What is in lecture 3?' });
  assert.equal(one[0].type, 'chat');
  const id = one[0].id as string;
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.deepEqual((await api('GET', '/chats')).json.chats.map((c: any) => [c.id, c.title, c.messages]), [[id, 'What is in lecture 3?', 2]]);

  // Going on: the server gives the model the conversation it kept, not what the page says.
  await ask({ message: 'And in more detail?', chatId: id });
  const sent = seen.at(-1)!.messages.map((m) => [m.role, m.content]);
  assert.deepEqual(sent.slice(1), [
    ['user', 'What is in lecture 3?'],
    ['assistant', 'Answer 1.'],
    ['user', 'And in more detail?'],
  ]);
  const kept = (await api('GET', `/chats/${id}`)).json;
  assert.deepEqual([kept.answering, kept.turns.map((t: any) => [t.role, t.text])], [false, [['user', 'What is in lecture 3?'], ['assistant', 'Answer 1.'], ['user', 'And in more detail?'], ['assistant', 'Answer 2.']]]);
  assert.equal(kept.turns[3].end.model, 'fake');

  // A conversation whose answer is still being written is not written into twice.
  writeChat({ ...readChat(id)!, answering: true });
  assert.equal((await api('POST', '/chat', { message: 'Again', chatId: id })).status, 409);
  writeChat({ ...readChat(id)!, answering: false });

  // What the model is given is cut from the oldest end, and it is told.
  process.env.CHAT_HISTORY_CHARS = '20';
  const h = historyOf(readChat(id)!);
  assert.deepEqual([h.history.length, h.left], [2, 2]);
  delete process.env.CHAT_HISTORY_CHARS;

  // Marked as answering before this server started (a restart in the middle): it is not, and can be gone on with.
  writeChat({ ...readChat(id)!, answering: true, updated: '2000-01-01T00:00:00.000Z' });
  assert.equal((await api('GET', `/chats/${id}`)).json.answering, false);

  // Deleted while an answer is written: it stays deleted.
  slow.ms = 300;
  const going = api('POST', '/chat', { message: 'Slowly', chatId: id });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api('DELETE', `/chats/${id}`)).status, 200);
  await going;
  slow.ms = 0;
  assert.equal((await api('GET', `/chats/${id}`)).status, 404);
  const again = await ask({ message: 'A new one' });
  const fresh = again[0].id as string;

  assert.equal((await api('GET', '/chats/..%2F..%2Fetc')).status, 404);
  assert.equal((await api('DELETE', `/chats/${fresh}`)).status, 200);
  assert.deepEqual((await api('GET', '/chats')).json.chats, []);
  assert.equal(readdirSync(join(dir, 'data', 'chats')).filter((f) => f.endsWith('.json')).length, 0);
});

test('the list of conversations is kept beside them, and listing does not read every conversation again', () => {
  // 500 conversations of 150 KB were read and parsed on every answer (a quarter of a second each time).
  const chats = join(dir, 'data', 'chats');
  const list = join(dir, 'data', 'chats-list.json');
  const made = ['First question', 'Second question'].map((q) => {
    const c = newChat(q);
    c.turns.push({ role: 'user', text: q, at: c.created });
    writeChat(c);
    return c;
  });
  const titles = () => listChats().map((c) => c.title).sort();
  assert.deepEqual(titles(), ['First question', 'Second question']);
  const file = join(chats, `${made[0].id}.json`);
  // A file whose size and time are as the list has them is not read: here it is made unreadable, and still listed.
  const at = new Date('2026-05-01T00:00:00Z');
  utimesSync(file, at, at);
  assert.deepEqual(titles(), ['First question', 'Second question']); // the new time is noted
  const body = readFileSync(file, 'utf8');
  writeFileSync(file, ' '.repeat(body.length));
  utimesSync(file, at, at);
  assert.deepEqual(titles(), ['First question', 'Second question']);
  // Changed in size or time: read again (an unreadable one is left out, as before).
  writeFileSync(file, body.replace('First question', 'Another question'));
  assert.deepEqual(titles(), ['Another question', 'Second question']);
  // No list, or one that cannot be read: made again from the files.
  rmSync(list);
  assert.deepEqual(titles(), ['Another question', 'Second question']);
  writeFileSync(list, '{ not json');
  assert.deepEqual(titles(), ['Another question', 'Second question']);
  // A conversation removed, by the page or by hand, leaves the list.
  assert.equal(deleteChat(made[0].id), true);
  rmSync(join(chats, `${made[1].id}.json`));
  assert.deepEqual(listChats(), []);
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')).chats, {});
});
