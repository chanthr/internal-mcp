/**
 * How the documents in the local folders point at each other: a knowledge graph read from what people wrote.
 *
 * A link is taken from Markdown as it is written, with no model in between:
 *   - [[Note]], [[Note|shown text]], [[folder/Note#Heading]], ![[Note]]      (wiki links, as Obsidian writes them)
 *   - [text](other.md), [text](../guides/setup.md "title"), [ref]: other.md  (Markdown links to documents)
 *   - a header field that names documents: `related: [a.md, "[[Note]]"]`, `parent: ...`, any field
 *
 * Two steps, kept apart on purpose:
 *   1. Each scan of the folders writes down, per document, the targets as written (links.json in the data
 *      directory). Only a document that changed is read again.
 *   2. Targets are matched to documents when the graph is asked for, the way Obsidian does it: a path from the
 *      document, a path from the folder, a file name anywhere, a title or an alias. So a note that is added later
 *      makes yesterday's dangling link whole, without reading anything again.
 *
 * A link in the text that matches no document is reported as broken, when it plainly meant a document: a wiki
 * link, or a path that ends like a document. What only might be one is left alone when it matches nothing: a
 * header field (those also name code paths and tickets), a Markdown link without an ending ("[n](<=30)" in a
 * table is not a note), and a path that climbs out of the folder (it points at something this server was not
 * given).
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dataFile } from '../../core/data_file.js';
import { parseFrontmatter } from '../drive/chunker.js';

export interface LinkRef {
  /** The target as written, cleaned (no alias, no heading). */
  to: string;
  /** From a header field rather than the text. */
  meta?: true;
  /** Might not be meant as a document (a Markdown link without an ending): no complaint when it matches nothing. */
  soft?: true;
}
export interface DocEntry {
  /** Modified time of the file when its links were read. */
  modified: string;
  title?: string;
  aliases?: string[];
  links: LinkRef[];
}
/** folder name → path inside the folder → what that document links to. */
export interface LinkMap {
  version: 1;
  folders: Record<string, Record<string, DocEntry>>;
}

/** links.json: the link map, with `key` first, a fingerprint of what the links are (linksKey). */
const file = dataFile<LinkMap & { key?: string }>('links.json');
const usable = (m: (LinkMap & { key?: string }) | null): m is LinkMap & { key?: string } => m?.version === 1 && !!m.folders && typeof m.folders === 'object';
export const readLinkMap = (): LinkMap => {
  const m = file.read();
  return usable(m) ? { version: 1, folders: m.folders } : { version: 1, folders: {} };
};
export const writeLinkMap = (map: LinkMap): void => file.write({ version: 1, key: linksKey(map), folders: map.folders });

/**
 * A fingerprint of what the graph is made from: the documents, their titles and other names, and their links. Not
 * when each was modified: a scan writes the map again whenever a file is saved, and building the graph again for
 * that took a quarter of a second at 20,000 documents, on the next search.
 */
function linksKey(map: LinkMap): string {
  const h = createHash('sha1');
  for (const [folder, docs] of Object.entries(map.folders)) {
    h.update(`\u0000${folder}\u0000`);
    for (const [path, d] of Object.entries(docs)) h.update(JSON.stringify([path, d.title ?? null, d.aliases ?? [], d.links]));
  }
  return h.digest('hex');
}

/** The fingerprint at the head of links.json, read without reading the rest; null when it has none. */
function keyOnDisk(): string | null {
  try {
    const fd = openSync(file.path(), 'r');
    try {
      const head = Buffer.alloc(80);
      const n = readSync(fd, head, 0, head.length, 0);
      return /^\{"version":1,"key":"([0-9a-f]{40})"/.exec(head.toString('utf8', 0, n))?.[1] ?? null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

const DOC_EXT = /\.(md|markdown|mdx|txt|pdf|docx|pptx|xlsx)$/i;
/** Things a wiki link embeds that are not documents. */
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|heic|mp4|mov|webm|mp3|wav|m4a|ogg|canvas|css|js|ts|json|csv|zip|html?)$/i;
/** Header fields that describe the document itself and never name another one. */
const OWN_FIELDS = new Set(['title', 'aliases', 'alias', 'tags', 'tag', 'date', 'created', 'updated', 'modified', 'status', 'type', 'author', 'authors', 'description', 'summary', 'confidence', 'cssclass', 'cssclasses', 'publish', 'lang']);

const nfc = (s: string) => s.normalize('NFC');

/** A target as written → the part that names a document. Empty when it names none (a heading of the same page). */
function cleanTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
  t = t.replace(/[#^?].*$/s, '').trim(); // a heading, a block or a query is a place inside the document
  if (/%[0-9A-Fa-f]{2}/.test(t)) {
    try {
      t = decodeURIComponent(t);
    } catch {
      /* not an encoded path: keep it as written */
    }
  }
  t = nfc(t).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/\s+/g, ' ');
  return t.length > 300 ? '' : t;
}

/**
 * A document is not read for links past this. Every step below takes time in proportion to what it is given, and
 * this bounds what it is given: a file somebody dropped in a folder must not be able to stop the server.
 */
const MAX_LINK_TEXT = 4_000_000;
/** A line longer than this is not prose with links in it (a minified file, a data dump). */
const MAX_LINK_LINE = 20_000;

/**
 * The text of a Markdown document without the places where a link is not a link: fenced code blocks and inline
 * code. Read line by line, once. (A pattern with a back-reference did this before, and one line of backticks made
 * it try every length against the rest of the file.)
 */
function withoutCode(body: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split('\n')) {
    const lead = line.length - line.trimStart().length;
    const char = line[lead];
    let run = 0;
    if (lead <= 3 && (char === '`' || char === '~')) while (line[lead + run] === char) run++;
    if (fence) {
      // Closed by a line of the same character, at least as long, with nothing after it.
      if (run >= fence.length && char === fence.char && line.slice(lead + run).trim() === '') fence = null;
      continue;
    }
    if (run >= 3) {
      fence = { char, length: run };
      continue;
    }
    if (line.length > MAX_LINK_LINE) continue;
    out.push(line.includes('`') ? withoutInlineCode(line) : line);
  }
  return out.join('\n');
}

/** A line without its `inline code`: from a backtick to the next one. A backtick with no partner stays. */
function withoutInlineCode(line: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = line.indexOf('`', at);
    const close = open < 0 ? -1 : line.indexOf('`', open + 1);
    if (close < 0) return out + line.slice(at);
    out += line.slice(at, open);
    at = close + 1;
  }
}

/** The first top-level heading: "# Title", with the closing #s some people write taken off. */
function firstHeading(body: string): string | undefined {
  const line = /^#[ \t]+([^\n]*)$/m.exec(body)?.[1];
  if (line === undefined) return undefined;
  let end = line.trimEnd().length;
  while (end > 0 && line[end - 1] === '#') end--;
  const title = line.slice(0, end).trim();
  return title && title.length <= 300 ? title : undefined;
}

/** What a Markdown document links to, its title and the other names it goes by. */
export function extractLinks(markdown: string): { title?: string; aliases?: string[]; links: LinkRef[] } {
  const { frontmatter, body } = parseFrontmatter(markdown.length > MAX_LINK_TEXT ? markdown.slice(0, MAX_LINK_TEXT) : markdown);
  const found = new Map<string, { meta: boolean; soft: boolean }>(); // target → how sure it is a link of the text
  const add = (raw: string, meta: boolean, path: boolean) => {
    const t = cleanTarget(raw);
    if (!t || ASSET_EXT.test(t)) return;
    // A path names a document when it ends like one. A wiki link names a note also without an ending.
    if (path && /\.[A-Za-z0-9]{1,5}$/.test(t) && !DOC_EXT.test(t)) return;
    const soft = path && !DOC_EXT.test(t);
    const had = found.get(t);
    found.set(t, had ? { meta: had.meta && meta, soft: had.soft && soft } : { meta, soft });
  };
  const text = withoutCode(body);
  for (const m of text.matchAll(/\[\[([^[\]\n]{1,300})\]\]/g)) add(m[1].split('|')[0], false, false);
  // [text](target) and [text](target "title"), not ![image](…); a target with a scheme (https:, mailto:) is the web.
  const web = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
  for (const m of text.matchAll(/(?<!!)\[[^\]\n]{0,300}\]\([ \t]*(<[^>\n]{1,1000}>|[^)\s]{1,1000})(?:[ \t]+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?[ \t]*\)/g)) if (!web.test(m[1].replace(/^</, ''))) add(m[1], false, true);
  for (const m of text.matchAll(/^ {0,3}\[[^\]\n]{1,300}\]:[ \t]*(<[^>\n]{1,1000}>|\S{1,1000})/gm)) if (!web.test(m[1].replace(/^</, ''))) add(m[1], false, true);

  const fromField = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(fromField);
    if (typeof v !== 'string') return;
    const wiki = [...v.matchAll(/\[\[([^[\]\n]{1,300})\]\]/g)];
    if (wiki.length) for (const m of wiki) add(m[1].split('|')[0], true, false);
    else if (DOC_EXT.test(v.trim()) && !web.test(v.trim())) add(v, true, true);
  };
  for (const [key, value] of Object.entries(frontmatter)) if (!OWN_FIELDS.has(key.toLowerCase())) fromField(value);

  const names = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => nfc(x.trim()));
  const heading = firstHeading(body);
  const title = names(frontmatter.title)[0] ?? (heading ? nfc(heading) : undefined);
  const aliases = [...names(frontmatter.aliases), ...names(frontmatter.alias)];
  const links = [...found].map(([to, how]): LinkRef => ({ to, ...(how.meta ? { meta: true as const } : {}), ...(how.soft && !how.meta ? { soft: true as const } : {}) }));
  return { ...(title ? { title } : {}), ...(aliases.length ? { aliases } : {}), links };
}

/**
 * The links of one file, for the scan. `previous` is what was written down last time: it is kept when the file
 * has not changed since. Only Markdown is read; other formats are documents that can be linked to.
 */
export async function linksOfFile(f: { abs: string; mimeType: string; modifiedTime: string }, previous?: DocEntry): Promise<DocEntry> {
  if (previous && previous.modified === f.modifiedTime) return previous;
  if (f.mimeType !== 'text/markdown') return { modified: f.modifiedTime, links: [] };
  try {
    return { modified: f.modifiedTime, ...extractLinks(await readFile(f.abs, 'utf8')) };
  } catch {
    return { modified: f.modifiedTime, links: [] };
  }
}

// ── The graph ──

export interface GraphNode {
  /** The document ID search and read use: "local:<folder>/<path>". */
  id: string;
  /** "<folder>/<path>": what per-user folder limits are matched against. */
  path: string;
  title: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  /** Named in a header field (related, parent, …) rather than in the text. */
  meta: boolean;
  /** The target as it was written. */
  written: string;
  /** Written in the text, plainly as a document: were the target not there, this would be a broken link. */
  plain: boolean;
}
export interface Graph {
  nodes: Map<string, GraphNode>;
  /** Document → what it links to. */
  out: Map<string, GraphEdge[]>;
  /** Document → what links to it. */
  in: Map<string, GraphEdge[]>;
  /** Links in the text that match no document. */
  broken: Array<{ from: string; target: string }>;
  edges: number;
}

const LOCAL = 'local:';
const lower = (s: string) => nfc(s).toLowerCase();
const stripExt = (p: string) => p.replace(DOC_EXT, '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const depth = (p: string) => p.split('/').length;

/** "a/b/../c" → "a/c". Null when it climbs out of the folder. */
function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

interface FolderIndex {
  name: string;
  /** lowercased path, with and without its ending → the path as it is. */
  byPath: Map<string, string>;
  /** lowercased file name without ending → paths. */
  byBase: Map<string, string[]>;
  /** lowercased title or alias → paths. */
  byName: Map<string, string[]>;
}

function indexFolder(name: string, docs: Record<string, DocEntry>): FolderIndex {
  const ix: FolderIndex = { name, byPath: new Map(), byBase: new Map(), byName: new Map() };
  const push = (m: Map<string, string[]>, k: string, v: string) => void (m.get(k)?.push(v) ?? m.set(k, [v]));
  for (const [path, doc] of Object.entries(docs)) {
    ix.byPath.set(lower(path), path);
    if (!ix.byPath.has(lower(stripExt(path)))) ix.byPath.set(lower(stripExt(path)), path);
    push(ix.byBase, lower(stripExt(baseOf(path))), path);
    for (const n of [doc.title, ...(doc.aliases ?? [])]) if (n) push(ix.byName, lower(n), path);
  }
  return ix;
}

/** Of several documents a name could mean: the one next to the linking document, then the one nearest the top. */
function nearest(candidates: string[], fromDir: string): string {
  return [...candidates].sort((a, b) => Number(dirOf(b) === fromDir) - Number(dirOf(a) === fromDir) || depth(a) - depth(b) || a.localeCompare(b))[0];
}

/** Match a target to a document of one folder. `fromPath` is set when the linking document is in this folder. */
function resolveIn(ix: FolderIndex, target: string, fromPath: string | null): string | null {
  const t = lower(target);
  const fromDir = fromPath === null ? '' : dirOf(fromPath);
  // 1. A path from the linking document.
  if (fromPath !== null) {
    const rel = normalizePath(fromDir ? `${lower(fromDir)}/${t}` : t);
    if (rel && ix.byPath.has(rel)) return ix.byPath.get(rel)!;
  }
  // 2. A path from the top of the folder. Written from further up ("wiki/guides/a.md" inside the folder "wiki"),
  //    the leading part is let go step by step.
  const parts = (normalizePath(t) ?? t).split('/');
  for (let i = 0; i < parts.length; i++) {
    const hit = ix.byPath.get(parts.slice(i).join('/'));
    if (hit && (i === 0 || parts.length - i > 1)) return hit;
  }
  // 3. A file name anywhere in the folder (and, when folders were written, a path that ends like the target).
  const named = ix.byBase.get(stripExt(baseOf(t)));
  if (named) {
    const wanted = stripExt(t);
    const ending = named.filter((p) => !wanted.includes('/') || `/${lower(stripExt(p))}`.endsWith(`/${wanted}`));
    const sameKind = DOC_EXT.test(t) ? ending.filter((p) => lower(p).endsWith(t.slice(t.lastIndexOf('.')))) : ending;
    if (sameKind.length) return nearest(sameKind, fromDir);
  }
  // 4. A title or an alias.
  const titled = ix.byName.get(t);
  return titled ? nearest(titled, fromDir) : null;
}

export function buildGraph(map: LinkMap): Graph {
  const g: Graph = { nodes: new Map(), out: new Map(), in: new Map(), broken: [], edges: 0 };
  const folders = Object.entries(map.folders).map(([name, docs]) => ({ ix: indexFolder(name, docs), docs }));
  const idOf = (folder: string, path: string) => `${LOCAL}${folder}/${path}`;
  for (const { ix, docs } of folders) {
    for (const [path, doc] of Object.entries(docs)) g.nodes.set(idOf(ix.name, path), { id: idOf(ix.name, path), path: `${ix.name}/${path}`, title: doc.title ?? stripExt(baseOf(path)) });
  }
  for (const { ix, docs } of folders) {
    for (const [path, doc] of Object.entries(docs)) {
      const from = idOf(ix.name, path);
      const seen = new Map<string, GraphEdge>();
      for (const link of doc.links) {
        // The linking document's own folder first, then the others: a vault and a second folder can link across.
        let to = resolveIn(ix, link.to, path);
        let home = ix.name;
        if (!to) {
          for (const other of folders) {
            if (other.ix === ix) continue;
            const prefix = `${lower(other.ix.name)}/`;
            const target = lower(link.to).startsWith(prefix) ? link.to.slice(prefix.length) : link.to;
            to = resolveIn(other.ix, target, null);
            if (to) {
              home = other.ix.name;
              break;
            }
          }
        }
        if (!to) {
          // Said in the text, plainly a document, and meant to be inside this folder: that is a broken link.
          const leavesFolder = normalizePath(dirOf(path) ? `${dirOf(path)}/${link.to}` : link.to) === null;
          if (!link.meta && !link.soft && !leavesFolder) g.broken.push({ from, target: link.to });
          continue;
        }
        const id = idOf(home, to);
        if (id === from) continue;
        const had = seen.get(id);
        const plain = !link.meta && !link.soft;
        if (had) {
          had.meta = had.meta && !!link.meta; // said in the text as well: a link of the text
          had.plain = had.plain || plain;
        } else seen.set(id, { from, to: id, meta: !!link.meta, written: link.to, plain });
      }
      if (seen.size) g.out.set(from, [...seen.values()]);
      for (const e of seen.values()) void (g.in.get(e.to)?.push(e) ?? g.in.set(e.to, [e]));
      g.edges += seen.size;
    }
  }
  return g;
}

let cached: { stamp: string; key: string | null; graph: Graph } | null = null;

/**
 * The graph of what is written down now, whichever process wrote it. Built again only when the links changed: a
 * links.json written again because a file was saved, with the same links, keeps the graph built before.
 */
export function getGraph(): Graph {
  const stamp = file.stamp();
  if (cached?.stamp === stamp) return cached.graph;
  const key = keyOnDisk();
  if (cached && key && cached.key === key) {
    cached.stamp = stamp;
    return cached.graph;
  }
  const m = file.read();
  cached = { stamp, key: usable(m) ? (m.key ?? null) : null, graph: buildGraph(usable(m) ? { version: 1, folders: m.folders } : { version: 1, folders: {} }) };
  return cached.graph;
}

/** Documents with no link to or from them. */
export function unlinked(g: Graph): GraphNode[] {
  return [...g.nodes.values()].filter((n) => !g.out.has(n.id) && !g.in.has(n.id));
}
