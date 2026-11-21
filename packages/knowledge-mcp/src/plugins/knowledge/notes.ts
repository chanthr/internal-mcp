/**
 * Notes: Markdown files this server writes for the person, in two folders beside the settings.
 *
 *   notes/          what the console's chat saves for the person (save_note), and what they write there themselves
 *   inbox/<who>/    what other assistants and programs send: save_note from an MCP client, or POST /inbox (an
 *                   automation such as a browser agent's routine). One folder per caller (fromName).
 *
 * Both are folders of this server like any other (searched, read, linked, read into the wiki) and open in Obsidian.
 * They are indexed as soon as they exist, without being added to the config (folders.ts builtInFolders).
 *
 * A note never writes over another file: a second note with the same title on the same day gets a number. With
 * `path`, a note already there is replaced, and only there: in notes/ for the console, in the caller's own
 * inbox/<who>/ for anyone else. What it said before is kept in a hidden .versions/ folder beside it (not searched),
 * so a note replaced by mistake, or by an assistant led astray by a document, can be had back. Nothing is written
 * through a link: a link in these folders could lead to the person's documents.
 *
 * Who a note is from is the caller (the key's owner), not what the caller says: a label it gives is kept as `via`.
 * The note's front matter records the caller's whole identity (`from`), and only that caller may replace it.
 *
 * Folders made before there was one per caller are named after the part of an email before the @ (inbox/kim/).
 * Their notes stay where they are, searched and read like the others. They record only that name, so no caller
 * replaces them: two people could have shared such a folder.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { INBOX, NOTES, placeDir, type Place } from './folders.js';
import { pageName } from './wiki.js';

export { INBOX, NOTES, placeDir, type Place };

/** Who a note is from, as its front matter records it: the caller's whole identity ("kim@example.com", "key-1a2b3c4d"). */
const identityOf = (from: string | undefined): string => (from ?? '').normalize('NFC').trim().toLowerCase().slice(0, 254) || 'other';

/**
 * The folder of a caller's notes under inbox/, one per caller: "kim@example.com", "key-1a2b3c4d", "local". The whole
 * identity is the name when it is safe as one; otherwise its safe part and a short hash of the whole, so that two
 * callers never share a folder. (The part before the @ alone made kim@example.com and kim@example.org one folder,
 * where each could replace the other's notes.)
 */
export function fromName(from: string | undefined): string {
  const who = identityOf(from);
  if (/^[\p{L}\p{N}](?:[\p{L}\p{N}._+@-]{0,78}[\p{L}\p{N}])?$/u.test(who)) return who;
  const safe = who.replace(/[^\p{L}\p{N}._+@-]+/gu, '-').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 40);
  return `${safe || 'other'}-${createHash('sha256').update(who).digest('hex').slice(0, 10)}`;
}

export interface SavedNote {
  /** Path inside the folder, to replace the note later. */
  path: string;
  /** Where it is, from the folder of this server: "notes/2026-11-20 Lecture 3.md". */
  shown: string;
  created: boolean;
}

const yaml = (s: string): string => JSON.stringify(s);
/** A value of a note's front matter (`title: "…"`), or null. */
function frontField(text: string, key: string): string | null {
  const head = /^---\n[\s\S]*?\n---/.exec(text)?.[0] ?? '';
  return new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm').exec(head)?.[1]?.trim() || null;
}
const day = (): string => new Date().toISOString().slice(0, 10);

/** The note's file: front matter that says what it is and where it came from, then the text. */
function noteText(o: { title: string; content: string; tags: string[]; from: string; via?: string; url?: string; created: string }): string {
  const body = o.content.trim();
  return [
    '---',
    `title: ${yaml(o.title)}`,
    `date: ${o.created}`,
    `updated: ${day()}`,
    ...(o.tags.length ? [`tags: [${o.tags.map(yaml).join(', ')}]`] : []),
    `from: ${yaml(o.from)}`,
    ...(o.via ? [`via: ${yaml(o.via)}`] : []),
    ...(o.url ? [`source: ${yaml(o.url)}`] : []),
    '---',
    // A note that does not start with its own heading gets its title as one.
    ...(/^#\s/.test(body) ? [] : [`# ${o.title}`, '']),
    body,
    '',
  ].join('\n');
}

/** No step from `base` to `target` may be a link (a link could lead out of the folder). Throws the step that is. */
function noLinks(base: string, target: string): void {
  const steps = relative(base, target).split(sep).filter(Boolean);
  for (let i = 0; i <= steps.length; i++) {
    const at = join(base, ...steps.slice(0, i));
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`${relative(base, at) || '.'} is a link. Notes are not written through links.`);
  }
}

/**
 * Write a note. `place`: notes (the console's chat) or inbox (anyone else, in the folder of `from`, who the caller
 * is). `via`: what the caller says it is (an app's name), kept in the front matter only. `path`: replace that note
 * instead (a path an earlier save gave; only inside the caller's own folder, only a .md file that is there). Throws
 * with a sentence for the caller when the path is not one it may replace.
 */
export function saveNote(o: { title: string; content: string; tags?: string[]; place: Place; from?: string; via?: string; url?: string; path?: string; dir?: string }): SavedNote {
  const root = placeDir(o.place, o.dir);
  const from = o.place === NOTES ? 'console' : identityOf(o.from);
  const folder = fromName(from);
  // The caller's own folder: notes/ for the console, inbox/<who>/ for anyone else.
  const own = o.place === INBOX ? join(root, folder) : root;
  const title = o.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  const tags = [...new Set((o.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  const via = o.via ? o.via.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
  let file: string;
  let created = true;
  let createdDay = day();
  if (o.path) {
    // A path is relative to the caller's own folder; one an earlier save gave (inbox/<who>/… shown as <who>/…) too.
    const rel = o.place === INBOX && o.path.replace(/\\/g, '/').startsWith(`${folder}/`) ? o.path.slice(folder.length + 1) : o.path;
    file = resolve(own, rel);
    const refused = new Error(`There is no note of yours at ${o.path} in ${o.place}/ to replace. Leave path out to save a new note.`);
    // Only a note in the caller's folder: never another caller's, never anything else on the computer.
    if (!file.startsWith(`${own}${sep}`) || !file.toLowerCase().endsWith('.md') || !existsSync(file)) throw refused;
    noLinks(dirname(root), file);
    const before = readFileSync(file, 'utf8');
    // In inbox/, only a note that records this very caller: a folder is not proof enough on its own (a note put
    // there by hand, or one from the folders shared before, records someone else or no one).
    if (o.place === INBOX && frontField(before, 'from') !== from) throw refused;
    created = false;
    createdDay = /^date:\s*(\d{4}-\d\d-\d\d)/m.exec(before)?.[1] ?? createdDay;
    // What it said before is kept, so a replacement can be undone.
    const versions = join(own, '.versions', dirname(relative(own, file)));
    mkdirSync(versions, { recursive: true });
    noLinks(dirname(root), versions);
    copyFileSync(file, join(versions, `${basename(file, '.md')} ${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  } else {
    noLinks(dirname(root), own);
    mkdirSync(own, { recursive: true });
    noLinks(dirname(root), own);
    const base = `${day()} ${pageName(title)}`;
    file = join(own, `${base}.md`);
    for (let n = 2; existsSync(file) || isLink(file); n++) file = join(own, `${base} (${n}).md`);
  }
  writeFileSync(file, noteText({ title, content: o.content, tags, from, via, url: o.url, created: createdDay }));
  const path = relative(root, file).split(sep).join('/');
  return { path, shown: `${o.place}/${path}`, created };
}
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// ── Reading them back (the console's Notes page) ──

export interface NoteEntry {
  place: Place;
  /** Path inside the folder. */
  path: string;
  title: string;
  /** From the front matter, when the note has it. */
  date: string | null;
  from: string | null;
  modified: string;
  size: number;
}

/** Every note in notes/ and inbox/, newest first. Links are not followed. */
export function listNotes(dir?: string, most = 2000): NoteEntry[] {
  const out: NoteEntry[] = [];
  for (const place of [NOTES, INBOX] as const) {
    const root = placeDir(place, dir);
    const walk = (rel: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= most || e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          const abs = join(root, path);
          const st = statSync(abs);
          const head = readFileSync(abs, 'utf8').slice(0, 2000);
          const field = (k: string) => frontField(head, k);
          out.push({ place, path, title: field('title') ?? /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? e.name.replace(/\.md$/i, ''), date: field('date'), from: field('from'), modified: st.mtime.toISOString(), size: st.size });
        }
      }
    };
    walk('');
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** One note's text. Only a Markdown file inside notes/ or inbox/, never through a link. */
export function readNote(place: Place, path: string, dir?: string): string {
  const root = placeDir(place, dir);
  const abs = resolve(root, path);
  if (!abs.startsWith(`${root}${sep}`) || !abs.toLowerCase().endsWith('.md') || !existsSync(abs) || lstatSync(abs).isSymbolicLink()) throw new Error('There is no such note.');
  if (statSync(abs).size > 2_000_000) throw new Error('The note is larger than 2 MB.');
  return readFileSync(abs, 'utf8');
}
