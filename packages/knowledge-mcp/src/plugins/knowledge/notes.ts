/**
 * Notes: Markdown files this server writes for the person, in two folders beside the settings.
 *
 *   notes/          what the console's chat saves for the person (save_note), and what they write there themselves
 *   inbox/<from>/   what other assistants and programs send: save_note from an MCP client, or POST /inbox (an
 *                   automation such as a browser agent's routine)
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
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { INBOX, NOTES, placeDir, type Place } from './folders.js';
import { pageName } from './wiki.js';

export { INBOX, NOTES, placeDir, type Place };

/** A name for where a note came from, safe as a folder name: "aside", "claude", "key-1a2b3c4d". */
export function fromName(from: string | undefined): string {
  const name = (from ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return name || 'other';
}

export interface SavedNote {
  /** Path inside the folder, to replace the note later. */
  path: string;
  /** Where it is, from the folder of this server: "notes/2026-11-20 Lecture 3.md". */
  shown: string;
  created: boolean;
}

const yaml = (s: string): string => JSON.stringify(s);
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
  const from = o.place === NOTES ? 'console' : fromName(o.from);
  // The caller's own folder: notes/ for the console, inbox/<who>/ for anyone else.
  const own = o.place === INBOX ? join(root, from) : root;
  const title = o.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  const tags = [...new Set((o.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  const via = o.via ? o.via.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
  let file: string;
  let created = true;
  let createdDay = day();
  if (o.path) {
    // A path is relative to the caller's own folder; one an earlier save gave (inbox/<who>/… shown as <who>/…) too.
    const rel = o.place === INBOX && o.path.replace(/\\/g, '/').startsWith(`${from}/`) ? o.path.slice(from.length + 1) : o.path;
    file = resolve(own, rel);
    // Only a note in the caller's folder: never another caller's, never anything else on the computer.
    if (!file.startsWith(`${own}${sep}`) || !file.toLowerCase().endsWith('.md') || !existsSync(file)) {
      throw new Error(`There is no note of yours at ${o.path} in ${o.place}/ to replace. Leave path out to save a new note.`);
    }
    noLinks(dirname(root), file);
    created = false;
    createdDay = /^date:\s*(\d{4}-\d\d-\d\d)/m.exec(readFileSync(file, 'utf8'))?.[1] ?? createdDay;
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
