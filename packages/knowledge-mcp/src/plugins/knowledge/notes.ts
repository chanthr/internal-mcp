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
 * `path`, a note already in these folders is replaced, and only there: the person's own documents are never
 * changed by this.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
function noteText(o: { title: string; content: string; tags: string[]; from: string; url?: string; created: string }): string {
  const body = o.content.trim();
  return [
    '---',
    `title: ${yaml(o.title)}`,
    `date: ${o.created}`,
    `updated: ${day()}`,
    ...(o.tags.length ? [`tags: [${o.tags.map(yaml).join(', ')}]`] : []),
    `from: ${yaml(o.from)}`,
    ...(o.url ? [`source: ${yaml(o.url)}`] : []),
    '---',
    // A note that does not start with its own heading gets its title as one.
    ...(/^#\s/.test(body) ? [] : [`# ${o.title}`, '']),
    body,
    '',
  ].join('\n');
}

/**
 * Write a note. `place`: notes (the console's chat) or inbox (anyone else, in a folder named after `from`).
 * `path`: replace that note instead (a path an earlier save gave; only inside the same folder, only a .md file
 * that is there). Throws with a sentence for the caller when the path is not one it may replace.
 */
export function saveNote(o: { title: string; content: string; tags?: string[]; place: Place; from?: string; url?: string; path?: string; dir?: string }): SavedNote {
  const root = placeDir(o.place, o.dir);
  const from = o.place === NOTES ? 'console' : fromName(o.from);
  const title = o.title.replace(/\s+/g, ' ').trim().slice(0, 200);
  const tags = [...new Set((o.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 12);
  let file: string;
  let created = true;
  let createdDay = day();
  if (o.path) {
    file = resolve(root, o.path);
    // Only a note in this folder: never anything else on the computer, never the person's documents.
    if (!file.startsWith(`${root}${sep}`) || !file.toLowerCase().endsWith('.md') || !existsSync(file)) {
      throw new Error(`There is no note at ${o.path} in ${o.place}/ to replace. Leave path out to save a new note.`);
    }
    created = false;
    createdDay = /^date:\s*(\d{4}-\d\d-\d\d)/m.exec(readFileSync(file, 'utf8'))?.[1] ?? createdDay;
  } else {
    const folder = o.place === INBOX ? join(root, from) : root;
    mkdirSync(folder, { recursive: true });
    const base = `${day()} ${pageName(title)}`;
    file = join(folder, `${base}.md`);
    for (let n = 2; existsSync(file); n++) file = join(folder, `${base} (${n}).md`);
  }
  writeFileSync(file, noteText({ title, content: o.content, tags, from, url: o.url, created: createdDay }));
  const path = relative(root, file).split(sep).join('/');
  return { path, shown: `${o.place}/${path}`, created };
}
