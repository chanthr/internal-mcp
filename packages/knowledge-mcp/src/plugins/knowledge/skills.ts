/**
 * Skills: instructions for a kind of task that an assistant reads when the task comes up, in the Agent Skills
 * format: a folder with SKILL.md, whose front matter gives a `name` and a `description`, and any files the
 * instructions refer to (templates, examples, reference pages).
 *
 * They are kept in skills/<name>/ beside the settings and shared with every assistant that uses this server: the
 * console's chat, and any MCP client through use_skill. An assistant is told only the names and descriptions; it
 * reads a skill when the task calls for it, so a skill costs nothing until it is used.
 *
 * Nothing in a skill is run here. A script in a skill is text the assistant may read; running code is not part of
 * this server (yet). A skill's text goes into the assistant's context like a document does, so install skills
 * from people you trust: the console shows a skill's text before and after it is installed.
 *
 * Installing: a folder on this computer is copied; a GitHub address (a repository, or a folder in one) is fetched
 * through GitHub's contents API, file by file, within limits (MOST_FILES, MOST_BYTES). A repository holding several
 * skills (skills/<name>/SKILL.md) installs each of them.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { settingsDir } from '../../core/config.js';

export const SKILLS = 'skills';
export const skillsDir = (dir: string = settingsDir()): string => join(resolve(dir), SKILLS);

/** Files one skill may have, and their bytes together. */
const MOST_FILES = 200;
const MOST_BYTES = 5_000_000;
/** Characters of a skill file given to an assistant at once. */
const MOST_CHARS = 200_000;

export interface Skill {
  name: string;
  description: string;
  /** Files besides SKILL.md, as paths inside the skill. */
  files: string[];
  /** Where it was installed from, when known. */
  source: string | null;
}

/** A skill's name as a folder name: lowercase letters (in any script), digits and dashes, as Agent Skills names are. */
export function skillName(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** The front matter of SKILL.md: `name` and `description` (a value on one line, quoted or not, or folded with > or |). */
export function frontMatter(text: string): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const head = m?.[1] ?? '';
  const value = (key: string): string => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head);
    if (!line) return '';
    let v = line[1].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      // A folded value: the indented lines after it.
      const after = head.slice(line.index + line[0].length).split(/\r?\n/);
      const lines: string[] = [];
      for (const l of after.slice(1)) {
        if (!/^\s+\S/.test(l)) break;
        lines.push(l.trim());
      }
      v = lines.join(v.startsWith('>') ? ' ' : '\n');
    }
    return v.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  };
  return { name: value('name'), description: value('description'), body: m ? text.slice(m[0].length) : text };
}

/** Every file of a folder, as paths inside it, without following links. */
function filesOf(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...filesOf(root, p));
    else if (e.isFile()) out.push(p);
    if (out.length > MOST_FILES) break;
  }
  return out;
}

const sourceFile = (root: string) => join(root, '.source');

/** The skills that are installed, by name. A folder without a readable SKILL.md is not one. */
export function listSkills(dir?: string): Skill[] {
  const root = skillsDir(dir);
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const at = join(root, e.name);
    try {
      const { description } = frontMatter(readFileSync(join(at, 'SKILL.md'), 'utf8'));
      out.push({
        name: e.name,
        description: description || '(no description)',
        files: filesOf(at).filter((f) => f !== 'SKILL.md'),
        source: existsSync(sourceFile(at)) ? readFileSync(sourceFile(at), 'utf8').trim() || null : null,
      });
    } catch {
      /* not a skill */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A skill's SKILL.md, or one of its files. Text only, inside the skill, never through a link. */
export function readSkill(name: string, file = 'SKILL.md', dir?: string): string {
  const root = join(skillsDir(dir), skillName(name));
  if (!existsSync(join(root, 'SKILL.md'))) throw new Error(`There is no skill named ${name}. ${listSkills(dir).length ? `The skills are: ${listSkills(dir).map((s) => s.name).join(', ')}.` : 'No skill is installed.'}`);
  const abs = resolve(root, file);
  if (!abs.startsWith(`${root}${sep}`) || !existsSync(abs) || lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) {
    throw new Error(`The skill ${name} has no file ${file}.`);
  }
  const bytes = readFileSync(abs);
  if (bytes.includes(0)) throw new Error(`${file} is not a text file.`);
  const text = bytes.toString('utf8');
  return text.length > MOST_CHARS ? `${text.slice(0, MOST_CHARS)}\n… [${text.length - MOST_CHARS} more characters]` : text;
}

/** Write a skill's files into skills/<name>/, replacing what was there under that name. */
function place(files: Map<string, Buffer>, source: string, dir?: string): Skill {
  const md = files.get('SKILL.md');
  if (!md) throw new Error('A skill needs a SKILL.md file.');
  const { name: declared, description } = frontMatter(md.toString('utf8'));
  const name = skillName(declared);
  if (!name) throw new Error('SKILL.md needs a name in its front matter (name: …).');
  if (!description) throw new Error(`${name}: SKILL.md needs a description in its front matter (description: …), so an assistant knows when to use it.`);
  if (files.size > MOST_FILES) throw new Error(`${name} has more than ${MOST_FILES} files.`);
  if ([...files.values()].reduce((n, b) => n + b.length, 0) > MOST_BYTES) throw new Error(`${name} is larger than ${MOST_BYTES / 1_000_000} MB.`);
  const root = join(skillsDir(dir), name);
  rmSync(root, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const abs = resolve(root, path);
    if (!abs.startsWith(`${root}${sep}`)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  writeFileSync(sourceFile(root), source);
  return listSkills(dir).find((s) => s.name === name)!;
}

/** Copy a skill from a folder on this computer (the folder holds SKILL.md), or every skill in its subfolders. */
export function installFromFolder(folder: string, dir?: string): Skill[] {
  const from = resolve(folder);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`${folder} is not a folder.`);
  const roots = existsSync(join(from, 'SKILL.md'))
    ? [from]
    : readdirSync(from, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(from, e.name, 'SKILL.md')))
        .map((e) => join(from, e.name));
  if (roots.length === 0) throw new Error(`There is no SKILL.md in ${folder} or in the folders right under it.`);
  return roots.map((root) => {
    const files = new Map<string, Buffer>();
    for (const f of filesOf(root)) files.set(f, readFileSync(join(root, f)));
    return place(files, root, dir);
  });
}

/** A skill written in the console: its name, description and instructions. */
export function createSkill(name: string, description: string, body: string, dir?: string): Skill {
  const md = `---\nname: ${skillName(name)}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}\n---\n\n${body.trim()}\n`;
  return place(new Map([['SKILL.md', Buffer.from(md)]]), 'written in the console', dir);
}

export function removeSkill(name: string, dir?: string): boolean {
  const root = join(skillsDir(dir), skillName(name));
  if (!skillName(name) || !existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  return true;
}

// ── From GitHub ──

/** github.com/<owner>/<repo>[/tree/<ref>/<path>] → its parts. */
export function githubPlace(url: string): { owner: string; repo: string; ref: string | null; path: string } {
  const u = new URL(url.trim());
  if (u.hostname !== 'github.com') throw new Error('Give a github.com address: a repository, or a folder in one.');
  const [owner, repo, kind, ref, ...rest] = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (!owner || !repo) throw new Error('Give the address of a repository: https://github.com/<owner>/<repo>.');
  if (kind && kind !== 'tree' && kind !== 'blob') throw new Error('Give a repository, or a folder in one (…/tree/<branch>/<folder>).');
  const path = kind === 'blob' ? rest.slice(0, -1).join('/') : rest.join('/');
  return { owner, repo, ref: ref ?? null, path };
}

interface Entry {
  type: 'file' | 'dir' | string;
  path: string;
  size: number;
  download_url: string | null;
}

/** Fetch every skill under a github.com address and install it. */
export async function installFromGithub(url: string, dir?: string, fetchImpl: typeof fetch = fetch): Promise<Skill[]> {
  const where = githubPlace(url);
  const token = process.env.GITHUB_PAT?.trim() || process.env.GITHUB_TOKEN?.trim();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'knowledge-mcp', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const api = (path: string) =>
    `https://api.github.com/repos/${encodeURIComponent(where.owner)}/${encodeURIComponent(where.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${where.ref ? `?ref=${encodeURIComponent(where.ref)}` : ''}`;
  const list = async (path: string): Promise<Entry[]> => {
    const res = await fetchImpl(api(path), { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) throw new Error(`GitHub has no folder ${path || '(the top)'} in ${where.owner}/${where.repo}${where.ref ? ` at ${where.ref}` : ''}, or it is private.`);
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now. Try again later, or connect GitHub on the Apps and data page.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const body = (await res.json()) as Entry[] | Entry;
    return Array.isArray(body) ? body : [body];
  };
  /** Every file under a folder, as paths inside it. */
  const walk = async (path: string, out: Entry[] = []): Promise<Entry[]> => {
    for (const e of await list(path)) {
      if (out.length > MOST_FILES) throw new Error(`There are more than ${MOST_FILES} files under ${path || 'the repository'}.`);
      if (e.type === 'dir' && !e.path.split('/').at(-1)!.startsWith('.')) await walk(e.path, out);
      else if (e.type === 'file') out.push(e);
    }
    return out;
  };
  // A folder that is a skill, or one whose folders are skills (one level down, or under skills/).
  const top = await list(where.path);
  let roots: string[];
  if (top.some((e) => e.type === 'file' && e.path.split('/').at(-1) === 'SKILL.md')) roots = [where.path];
  else {
    const dirs = top.filter((e) => e.type === 'dir').map((e) => e.path);
    const below = dirs.find((d) => d.split('/').at(-1) === SKILLS);
    const candidates = below ? (await list(below)).filter((e) => e.type === 'dir').map((e) => e.path) : dirs;
    roots = [];
    for (const d of candidates.slice(0, 50)) if ((await list(d)).some((e) => e.type === 'file' && e.path.split('/').at(-1) === 'SKILL.md')) roots.push(d);
  }
  if (roots.length === 0) throw new Error(`There is no SKILL.md at ${url}, nor in the folders right under it.`);
  const installed: Skill[] = [];
  for (const root of roots) {
    const files = new Map<string, Buffer>();
    let bytes = 0;
    for (const e of await walk(root)) {
      if (!e.download_url) continue;
      const dl = new URL(e.download_url);
      // Files come from GitHub's own hosts only.
      if (dl.hostname !== 'raw.githubusercontent.com' && dl.hostname !== 'github.com') continue;
      bytes += e.size;
      if (bytes > MOST_BYTES) throw new Error(`${root} is larger than ${MOST_BYTES / 1_000_000} MB.`);
      const res = await fetchImpl(dl, { headers: { 'User-Agent': 'knowledge-mcp', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${e.path}.`);
      files.set(relative(root, e.path).split(sep).join('/') || e.path, Buffer.from(await res.arrayBuffer()));
    }
    installed.push(place(files, `https://github.com/${where.owner}/${where.repo}${root ? `/tree/${where.ref ?? 'HEAD'}/${root}` : ''}`, dir));
  }
  return installed;
}
