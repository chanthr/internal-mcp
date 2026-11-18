/**
 * What a model is given to read: search results and documents, written to cost little and to say what they are.
 * Neighbouring parts come back as one passage, a poor keyword match is called one, a filter that matched nothing
 * says what it could have been, and a long document is read in parts or in stretches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docs = mkdtempSync(join(tmpdir(), 'kmcp-surface-'));
// A runbook long enough to be stored as many parts. Each section has a sentence of its own, said once.
const filler = (n: number) => `Section ${n} goes on with ordinary sentences about how the team works, so that it is long enough to be a part of its own. `.repeat(9);
const sections = [
  ['Overview', 'This runbook covers releases of the storefront.'],
  ['Before a release', 'The checklist has eleven items and lives in the tracker.'],
  ['Rollback', 'A zebracrossing rollback starts by freezing the queue.'],
  ['Rollback, continued', 'The zebracrossing rollback ends when the previous image serves traffic.'],
  ['After a release', 'The channel is told within ten minutes.'],
  ['Contacts', 'The release captain rotates every Monday.'],
];
writeFileSync(
  join(docs, 'runbook.md'),
  `---\ntype: guide\nstatus: current\ntags: [release, storefront]\n---\n# Release runbook\n\n${sections.map(([h, own], i) => `## ${h}\n\n${own} ${filler(i + 1)}`).join('\n\n')}\n`,
);
writeFileSync(join(docs, 'notes.md'), '---\ntype: note\n---\n# Notes\n\nThe offsite is planned for March.\n');

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_|GOOGLE_|KNOWLEDGE_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-surface-data-')),
  MCP_CONFIG_JSON: JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }),
});

const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { handleSearchKnowledge } = await import('../src/plugins/knowledge/tools/search_knowledge.js');
const { readDocumentTool } = await import('../src/plugins/knowledge/tools/read_document.js');
const { authStore } = await import('../src/core/context.js');
type Auth = Parameters<typeof authStore.run>[0];
const admin = { ok: true, role: 'admin', email: 'a@test', org_id: 'o' } as Auth;
const scoped = { ok: true, role: 'member', email: 's@test', org_id: 'o', scopes: { driveFolders: ['elsewhere'] } } as Auth;
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const search = (args: Record<string, unknown>, auth: Auth = admin) => authStore.run(auth, async () => text(await handleSearchKnowledge({ topK: 5, ...args } as never)));
// Through the tool's own schema, so the defaults a model gets are the ones tested.
const read = (args: Record<string, unknown>, auth: Auth = admin) =>
  authStore.run(auth, async () => {
    const r = (await readDocumentTool.run(readDocumentTool.input!.parse(args) as never, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: text(r), isError: r.isError === true };
  });
const times = (all: string, piece: string) => all.split(piece).length - 1;
const ID = 'local:docs/runbook.md';

await scanFolders();

test('neighbouring parts of a document come back as one passage, and nothing in it is said twice', async () => {
  const out = await search({ query: 'zebracrossing rollback' });
  const where = /^ID: `local:docs\/runbook\.md` · parts (\d+)-(\d+) of (\d+)/m.exec(out);
  assert.ok(where, out);
  assert.equal(Number(where[2]) - Number(where[1]), 1);
  assert.ok(Number(where[3]) >= 4, 'the runbook is stored as several parts');
  // Both sections are there, each sentence once: the lead-in the second part repeats from the first is gone.
  assert.equal(times(out, 'A zebracrossing rollback starts by freezing the queue.'), 1);
  assert.equal(times(out, 'The zebracrossing rollback ends when the previous image serves traffic.'), 1);
  assert.equal(times(out, '## 1. runbook.md'), 1);
  assert.ok(!/^## 2\. runbook\.md/m.test(out), 'the neighbour did not take a slot of its own');
  // topK counts parts: two neighbours shown as one passage are still two of them.
  const two = await search({ query: 'zebracrossing rollback', topK: 2 });
  assert.match(two, /^1 passage from 1 document/m);
  assert.match(two, /· parts \d+-\d+ of \d+/);
  // The head says once how to read on, and each passage says how well it matched.
  assert.equal(times(out, 'read_document'), 1);
  assert.match(out, /^Match: keyword \(2 of 2 terms of the question\)$/m); // one source: it is not named on every passage
  assert.ok(!out.includes('Weak match'));
});

test('a keyword match that holds little of the question is called weak', async () => {
  const out = await search({ query: 'zebracrossing quantum entanglement photon detector' });
  assert.match(out, /^> Weak match: no passage holds even half of the terms of the question\./m);
  assert.match(out, /^Match: keyword \(1 of 5 terms of the question\)$/m);
});

test('a filter that matched nothing says what the field holds, to those who may see everything', async () => {
  const out = await search({ query: 'rollback', docType: 'policy' });
  assert.match(out, /No results for "rollback"/);
  assert.match(out, /docType="policy"\); try without them\. In this index docType is one of: "guide", "note"/);
  assert.match(await search({ query: 'rollback', customer: 'Acme' }), /no document has a customer/);
  // Someone limited to other folders learns nothing about documents outside them.
  const hidden = await search({ query: 'rollback', docType: 'policy' }, scoped);
  assert.ok(!hidden.includes('one of') && !hidden.includes('guide'), hidden);
});

test('read_document: around a part, and a long document in stretches', async () => {
  // A search result names the part (or the parts) its passage is. Reading one of them alone returns that part.
  const found = await search({ query: 'release captain rotates Monday' });
  const named = /· parts? (\d+)(?:-(\d+))? of (\d+)/.exec(found)!;
  const total = Number(named[3]);
  const candidates = Array.from({ length: Number(named[2] ?? named[1]) - Number(named[1]) + 1 }, (_, i) => Number(named[1]) + i);
  const alone = (await Promise.all(candidates.map((part) => read({ documentId: ID, part, around: 0 })))).filter((r) => r.text.includes('The release captain rotates every Monday.'));
  assert.equal(alone.length, 1);
  assert.match(alone[0].text, new RegExp(`^# runbook\\.md\\nID: \`${ID}\` · modified \\d{4}-\\d{2}-\\d{2} · part \\d+ of ${total}`));
  assert.ok(alone[0].text.length < 3000, 'one part, not the document');

  // The default reads one part on each side, joined without repeating their edges.
  const around = await read({ documentId: ID, part: 3 });
  assert.match(around.text, /· parts 2-4 of \d+ · the next is part 5\n/);
  for (const [, own] of sections) assert.ok(times(around.text, own) <= 1, own);
  assert.ok(times(around.text, 'A zebracrossing rollback starts by freezing the queue.') === 1);

  const past = await read({ documentId: ID, part: 99 });
  assert.deepEqual([past.isError, /part 99 does not exist/.test(past.text)], [true, true]);
  assert.equal((await read({ documentIds: [ID], part: 1 }).catch((e) => ({ isError: true, text: String(e) }))).isError, true);

  // From the start, in stretches: the head says which stretch this is and where the next one begins.
  const start = await read({ documentId: ID, maxChars: 1000 });
  assert.match(start.text, /· characters 0-1,000 of [\d,]+ · continue with offset=1000\n\n---\ntype: guide/);
  const next = await read({ documentId: ID, maxChars: 1000, offset: 1000 });
  assert.match(next.text, /· characters 1,000-2,000 of [\d,]+ · continue with offset=2000\n/);
  assert.notEqual(next.text.split('\n\n').slice(1).join('\n\n'), start.text.split('\n\n').slice(1).join('\n\n'));
  const whole = await read({ documentId: ID, maxChars: 200000 });
  assert.match(whole.text, /· [\d,]+ characters, the whole document\n/);
  assert.equal((await read({ documentId: ID, offset: 10_000_000 })).isError, true);

  // What a search would not show is not read part by part either.
  assert.equal((await read({ documentId: ID, part: 1 }, scoped)).isError, true);
  assert.equal((await read({ documentId: 'local:docs/missing.md', part: 1 })).isError, true);
});
