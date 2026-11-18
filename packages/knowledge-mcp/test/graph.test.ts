/**
 * The knowledge graph (links between documents, read from what people wrote) and files dropped on the console.
 * The graph: what counts as a link, how a target finds its document, and that the tools and the page say the same.
 * Uploads: a file lands in one folder only, is searchable at once, and takes part in the graph.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_|GOOGLE_|DRIVE_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-graph-'));
const vault = join(dir, 'vault');
const handbook = join(dir, 'handbook');
const uploads = join(dir, 'uploads');
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
put(vault, 'Home.md', '# Home\n\nStart at [[Projects]] and [[people/Ann Lee|Ann]]. See [[Missing Page]]. ![[diagram.png]]\n\nNot links: `[[inline code]]`\n\n```\n[[in a code block]]\n```\n');
put(
  vault,
  'Projects.md',
  '---\ntitle: Project list\naliases: [Work]\nstatus: current\nrelated:\n  - guides/setup.md\n  - "[[Home]]"\n  - src/server.ts\n  - guides/gone.md\n---\n# Projects\n\n[Setup guide](guides/setup.md "how to") and [the site](https://example.com) and [mail](mailto:a@example.com) and ![a picture](shot.png).\n',
);
put(vault, 'guides/setup.md', '# Setup\n\nBack to [projects](../Projects.md#top) and [[Work]]. Also [encoded](../people/Ann%20Lee.md) and [a section](#install).\n\n[ref]: ../Home.md\n');
put(vault, 'guides/deep/notes.md', '# Notes\n\n[[setup]] and [[guides/setup]] and [[Projects]].\n');
put(vault, 'people/Ann Lee.md', '# Ann Lee\n\nWorks on [[Projects]].\n');
put(vault, 'alone.md', '# Alone\n\nNo links here.\n');
put(vault, 'data.txt', 'Plain text is a document, but [[Home]] in it is just text.\n');
put(handbook, 'Policy.md', '# Policy\n\nSee [[Home]] in the vault and [the setup page](vault/guides/setup.md).\n');
mkdirSync(uploads);
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: vault }, { path: handbook }, { path: uploads, name: 'uploads' }] }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false', // the test scans when it wants to
  PORT: '0',
});

const { extractLinks, buildGraph, getGraph, readLinkMap } = await import('../src/plugins/knowledge/graph.js');
const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { handleLinkedDocuments } = await import('../src/plugins/knowledge/tools/linked_documents.js');
const { handleSearchKnowledge } = await import('../src/plugins/knowledge/tools/search_knowledge.js');
const { uploadParts } = await import('../src/admin/uploads.js');
const { authStore } = await import('../src/core/context.js');
const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');

type Auth = Parameters<typeof authStore.run>[0];
const admin = { ok: true, role: 'admin', email: 'a@test', org_id: 'o' } as Auth;
const handbookOnly = { ok: true, role: 'member', email: 's@test', org_id: 'o', scopes: { driveFolders: ['handbook'] } } as Auth;
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const links = (args: Record<string, unknown> = {}, auth: Auth = admin) => authStore.run(auth, async () => textOf(await handleLinkedDocuments({ limit: 25, ...args } as never)));
const search = (query: string, auth: Auth = admin) => authStore.run(auth, async () => textOf(await handleSearchKnowledge({ query, topK: 5 } as never)));
const outOf = (id: string) => (getGraph().out.get(id) ?? []).map((e) => `${e.to.replace('local:', '')}${e.meta ? ' (header)' : ''}`).sort();
const into = (id: string) => (getGraph().in.get(id) ?? []).map((e) => e.from.replace('local:', '')).sort();

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
after(() => server.close());
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/console/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${consoleToken()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const upload = async (path: string, body: string, token: string | null = consoleToken()) => {
  const res = await fetch(`${base}/console/api/uploads?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

test('what counts as a link in a Markdown document', () => {
  const targets = (md: string) => extractLinks(md).links.map((l) => `${l.to}${l.meta ? ' (header)' : ''}`);
  // Wiki links as Obsidian writes them: the shown text and the heading are not part of the target, an embedded
  // note is a link, an embedded picture is not, and a link to a heading of the same page names no document.
  assert.deepEqual(targets('[[Note]] [[Other note|shown]] [[folder/Deep#Heading]] [[Block^abc]] ![[Embedded]] ![[shot.png]] [[#Here]]'), ['Note', 'Other note', 'folder/Deep', 'Block', 'Embedded']);
  // Markdown links to documents. The web, mail, pictures and other kinds of file are not documents of the graph.
  assert.deepEqual(
    targets('[a](one.md) [b](../two.md "title") [c](<with space.md>) [d](three%20four.md#part) [e](https://example.com/x.md) [f](mailto:a@b.c) ![g](pic.png) [h](src/main.ts) [i](#top) [j](report.pdf)'),
    ['one.md', '../two.md', 'with space.md', 'three four.md', 'report.pdf'],
  );
  assert.deepEqual(targets('See [the guide][g].\n\n[g]: guides/setup.md\n[web]: https://example.com\n'), ['guides/setup.md']);
  // A Markdown link without an ending may be a note ("[the plan](Plan)") or not a document at all ("[n](<=30)"):
  // it is kept as a maybe, and counts only if a document answers to it.
  assert.deepEqual(extractLinks('[the plan](Plan) and at most [n](<=30) and [[Plan]]').links, [{ to: 'Plan' }, { to: '<=30', soft: true }]);
  // Code is not prose.
  assert.deepEqual(targets('`[[inline]]`\n\n```md\n[[fenced]]\n[x](y.md)\n```\n\n~~~\n[[tilde]]\n~~~\n\n[[real]]'), ['real']);
  // Header fields: any field may name documents; fields that describe the document itself do not.
  const doc = extractLinks('---\ntitle: The plan\naliases: [Plan, Roadmap]\ntags: [a.md]\nrelated: [one.md, "[[Two]]"]\nparent: "[[Home]]"\naffects:\n  - src/server.ts\n  - docs/three.md\n---\n# Heading\n\nText with [[one]].\n');
  assert.deepEqual([doc.title, doc.aliases], ['The plan', ['Plan', 'Roadmap']]);
  assert.deepEqual(doc.links.map((l) => `${l.to}${l.meta ? ' (header)' : ''}`), ['one', 'one.md (header)', 'Two (header)', 'Home (header)', 'docs/three.md (header)']);
  // Without a title field, the first heading is the title.
  assert.equal(extractLinks('Intro.\n\n# The real title #\n').title, 'The real title');
});

test('a target finds its document the way a person would mean it', () => {
  const entry = (links: string[], extra: object = {}) => ({ modified: 'm', links: links.map((to) => ({ to })), ...extra });
  const g = buildGraph({
    version: 1,
    folders: {
      wiki: {
        'index.md': { modified: 'm', links: [...['guides/setup.md', 'setup', 'Deploy guide', 'wiki/guides/setup.md', 'team/readme', 'nowhere', 'index'].map((to) => ({ to })), { to: '<=30', soft: true as const }, { to: 'deploy', soft: true as const }, { to: '../outside/plan.md' }] },
        'guides/setup.md': entry(['../index.md', 'readme', './deploy.md']),
        'guides/deploy.md': entry([], { title: 'Deploy guide' }),
        'guides/readme.md': entry([]),
        'team/readme.md': entry([]),
        'team/한글 문서.md': entry(['한글 문서'.normalize('NFD')]), // typed on another system: the same name, written differently
        'team/notes.md': entry(['한글 문서'.normalize('NFD'), 'readme']),
      },
      other: { 'page.md': entry(['setup', 'wiki/team/readme.md']) },
    },
  });
  const to = (from: string) => (g.out.get(`local:${from}`) ?? []).map((e) => e.to.replace('local:', ''));
  // A path from the folder, a bare name, a title, the folder's own name in front, and a path that picks one of two files of the same name.
  // A maybe-link counts when a document answers to it ("deploy"), and is dropped without complaint when none does ("<=30").
  // A path that climbs out of the folder points at something this server was not given: not a link, and not broken.
  assert.deepEqual(to('wiki/index.md'), ['wiki/guides/setup.md', 'wiki/guides/deploy.md', 'wiki/team/readme.md']);
  // A path from the document itself; and of two files called readme, the one beside it.
  assert.deepEqual(to('wiki/guides/setup.md'), ['wiki/index.md', 'wiki/guides/readme.md', 'wiki/guides/deploy.md']);
  assert.deepEqual(to('wiki/team/notes.md'), ['wiki/team/한글 문서.md', 'wiki/team/readme.md']);
  assert.equal(g.out.has('local:wiki/team/한글 문서.md'), false); // a document does not link to itself
  // Another folder is looked in when the document's own has no match.
  assert.deepEqual(to('other/page.md'), ['wiki/guides/setup.md', 'wiki/team/readme.md']);
  assert.deepEqual(g.broken, [{ from: 'local:wiki/index.md', target: 'nowhere' }]);
  assert.deepEqual((g.in.get('local:wiki/guides/setup.md') ?? []).map((e) => e.from).sort(), ['local:other/page.md', 'local:wiki/index.md']);
});

test('scanning the folders writes the links down, and the graph is the same for the tools and the page', async () => {
  const first = await scanFolders();
  assert.deepEqual([first!.indexed, first!.errored], [8, 0]);
  // Written per document as the targets were typed; matching happens when the graph is asked for.
  assert.deepEqual(readLinkMap().folders.vault['Home.md'].links.map((l) => l.to), ['Projects', 'people/Ann Lee', 'Missing Page']);
  assert.deepEqual(readLinkMap().folders.vault['data.txt'].links, []);

  assert.deepEqual(outOf('local:vault/Home.md'), ['vault/Projects.md', 'vault/people/Ann Lee.md']);
  // Named in the header and in the text: a link of the text. Named in the header only: marked. Not a document, or gone: left out.
  assert.deepEqual(outOf('local:vault/Projects.md'), ['vault/Home.md (header)', 'vault/guides/setup.md']);
  assert.deepEqual(outOf('local:vault/guides/setup.md'), ['vault/Home.md', 'vault/Projects.md', 'vault/people/Ann Lee.md']);
  assert.deepEqual(outOf('local:vault/guides/deep/notes.md'), ['vault/Projects.md', 'vault/guides/setup.md']);
  assert.deepEqual(outOf('local:handbook/Policy.md'), ['vault/Home.md', 'vault/guides/setup.md']); // across folders
  assert.deepEqual(into('local:vault/Projects.md'), ['vault/Home.md', 'vault/guides/deep/notes.md', 'vault/guides/setup.md', 'vault/people/Ann Lee.md']);
  assert.deepEqual(getGraph().broken, [{ from: 'local:vault/Home.md', target: 'Missing Page' }]);

  // The overview: where to start.
  const overview = await links();
  assert.match(overview, /^# How the documents connect\n8 documents · 12 links · 2 documents with no links · 1 link to a document that does not exist$/m);
  assert.match(overview, /## Most linked to\n1\. Project list \(4 documents link here\) — `local:vault\/Projects\.md`\n2\. Home \(3 documents link here\)/);
  // Around one document: both directions, by title, with what was only named in a header marked.
  const around = await links({ documentId: 'local:vault/Projects.md' });
  assert.match(around, /^# Links of Project list\nID: `local:vault\/Projects\.md`\n\n## Links to \(2\)\n1\. Home \(named in its header\) — `local:vault\/Home\.md`\n2\. Setup — `local:vault\/guides\/setup\.md`\n\n## Linked from \(4\)\n1\. Ann Lee — /);
  assert.match(await links({ documentId: 'local:vault/Home.md' }), /## Links to a document that does not exist \(1\)\n- Missing Page/);
  assert.match(await links({ documentId: 'local:vault/alone.md' }), /Nothing links to this document and it links to nothing\./);
  assert.match(await links({ documentId: 'local:vault/nope.md' }), /No such document/);
  assert.match(await links({ documentId: 'some-drive-id' }), /local folders only/);

  // Search says which results are connected, and how to follow them, once.
  const found = await search('Start at Projects');
  assert.match(found, /To follow a document's links: linked_documents with its ID\./);
  assert.match(found, /## 1\. Home\.md[^\n]*\nID: `local:vault\/Home\.md`[^\n]*\n(?:[^\n]+\n)*?Links: to 2 · from 3\n/);
  assert.equal(found.split('linked_documents').length - 1, 1);
  // A document nothing links to, and that links to nothing, carries no such line.
  const lonely = /## \d+\. alone\.md[^]*?(?=\n## |$)/.exec(await search('No links here'))?.[0] ?? '';
  assert.ok(lonely.includes('ID: `local:vault/alone.md`') && !lonely.includes('Links:'), lonely);

  // Someone limited to one folder sees that folder's documents and nothing that leads out of it.
  assert.match(await links({}, handbookOnly), /^1 document · 0 links · 1 document with no links · 0 links to a document that does not exist$/m);
  assert.match(await links({ documentId: 'local:handbook/Policy.md' }, handbookOnly), /Nothing links to this document and it links to nothing\./);
  assert.match(await links({ documentId: 'local:vault/Home.md' }, handbookOnly), /No such document/);
  assert.ok(!(await search('Policy vault', handbookOnly)).includes('Links:'));

  // The page reads the same graph.
  const page = (await api('GET', '/graph')).json;
  assert.deepEqual([page.documents, page.links, page.unlinked, page.broken], [8, 12, 2, 1]);
  assert.deepEqual(page.top.slice(0, 2).map((d: any) => [d.title, d.in, d.out]), [['Project list', 4, 2], ['Home', 3, 2]]);
  assert.deepEqual(page.alone.map((d: any) => d.path).sort(), ['vault/alone.md', 'vault/data.txt']);
  assert.deepEqual(page.brokenLinks, [{ from: { id: 'local:vault/Home.md', title: 'Home', path: 'vault/Home.md', in: 3, out: 2 }, target: 'Missing Page' }]);
  const node = (await api('GET', `/graph/node?id=${encodeURIComponent('local:vault/Projects.md')}`)).json;
  assert.deepEqual([node.node.title, node.out.map((d: any) => [d.title, d.meta]), node.in.map((d: any) => d.title)], ['Project list', [['Home', true], ['Setup', false]], ['Ann Lee', 'Home', 'Notes', 'Setup']]);
  assert.deepEqual((await api('GET', '/graph/find?q=ann')).json.found.map((d: any) => d.path), ['vault/people/Ann Lee.md']);
  assert.equal((await api('GET', `/graph/node?id=${encodeURIComponent('local:vault/nope.md')}`)).status, 404);
  assert.equal((await fetch(`${base}/console/api/graph`)).status, 401);
});

test('the graph follows the folder: a new note mends a dangling link, an edit and a removal show', async () => {
  // The page that was missing is written. Home is not touched, and its link is whole.
  put(vault, 'Missing Page.md', '# Missing Page\n\nFound.\n');
  const homeBefore = readLinkMap().folders.vault['Home.md'];
  await scanFolders();
  assert.deepEqual(readLinkMap().folders.vault['Home.md'], homeBefore);
  assert.deepEqual([getGraph().broken, outOf('local:vault/Home.md').includes('vault/Missing Page.md')], [[], true]);

  // A link is taken out of a document.
  put(vault, 'people/Ann Lee.md', '# Ann Lee\n\nOn leave.\n');
  utimesSync(join(vault, 'people/Ann Lee.md'), new Date(), new Date(Date.now() + 5000));
  await scanFolders();
  assert.deepEqual(into('local:vault/Projects.md'), ['vault/Home.md', 'vault/guides/deep/notes.md', 'vault/guides/setup.md']);

  // A document is removed: it leaves the graph, and what pointed at it in the text now points nowhere.
  rmSync(join(vault, 'guides/setup.md'));
  await scanFolders();
  assert.equal(getGraph().nodes.has('local:vault/guides/setup.md'), false);
  assert.deepEqual(getGraph().broken.map((b) => `${b.from.replace('local:', '')} → ${b.target}`).sort(), [
    'handbook/Policy.md → vault/guides/setup.md',
    'vault/Projects.md → guides/setup.md',
    'vault/guides/deep/notes.md → guides/setup',
    'vault/guides/deep/notes.md → setup',
  ]);
});

test('a dropped file goes into uploads/ and nowhere else, is searchable at once, and joins the graph', async () => {
  // What a browser may name.
  assert.deepEqual(uploadParts('inbox\\\\Idea.md'.replace('\\\\', '\\')), ['inbox', 'Idea.md']);
  for (const [path, why] of [
    ['../outside.md', /cannot be part of a path/],
    ['notes/../../outside.md', /cannot be part of a path/],
    ['.env', /cannot be part of a path/],
    ['notes/.hidden/a.md', /cannot be part of a path/],
    ['node_modules/pkg/readme.md', /cannot be part of a path/],
    ['run.sh', /this type of file cannot be searched/],
    ['archive.zip', /this type of file cannot be searched/],
    ['/', /has no name/],
  ] as const) {
    const refused = await upload(path, 'x');
    assert.deepEqual([refused.status, why.test(refused.json.error)], [422, true], `${path}: ${JSON.stringify(refused.json)}`);
  }
  assert.equal((await upload('inbox/Idea.md', '# Idea', null)).status, 401); // the console token, like every change
  assert.equal(existsSync(join(uploads, 'inbox')), false);

  // A link out of the folder is not written through.
  const elsewhere = mkdtempSync(join(tmpdir(), 'kmcp-elsewhere-'));
  symlinkSync(elsewhere, join(uploads, 'shortcut'));
  const through = await upload('shortcut/a.md', '# A');
  assert.deepEqual([through.status, /is a link/.test(through.json.error), existsSync(join(elsewhere, 'a.md'))], [422, true, false]);
  rmSync(join(uploads, 'shortcut'));

  // A file, in the folder it was dropped with. A second time it replaces the first.
  const saved = await upload('inbox/Idea.md', '# Idea\n\nA zeppelin tour, related to [[Home]].\n');
  assert.deepEqual([saved.status, saved.json.path, saved.json.replaced], [200, 'inbox/Idea.md', false]);
  assert.match(readFileSync(join(uploads, 'inbox/Idea.md'), 'utf8'), /zeppelin tour/);
  assert.equal((await upload('inbox/Idea.md', '# Idea\n\nA zeppelin tour, related to [[Home]].\n')).json.replaced, true);
  assert.equal((await upload('한글 메모.md', '# 한글 메모\n\n내용.\n')).json.path, '한글 메모.md');

  // Done: the folder is one of this server's, so the files are read now.
  const done = await api('POST', '/uploads/done');
  assert.deepEqual([done.status, done.json.restarting, /2 read/.test(done.json.note)], [200, false, true], JSON.stringify(done.json));
  assert.match(await search('zeppelin tour'), /ID: `local:uploads\/inbox\/Idea\.md`/);
  assert.deepEqual(outOf('local:uploads/inbox/Idea.md'), ['vault/Home.md']);

  // The first upload ever: uploads/ is not a folder of the server yet, and becomes one.
  const config = JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));
  writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ ...config, folders: config.folders.filter((f: any) => f.path !== uploads) }));
  const firstTime = await api('POST', '/uploads/done');
  assert.deepEqual([firstTime.status, firstTime.json.restartNeeded], [200, true]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).folders.at(-1), { path: uploads, name: 'uploads' });
});
