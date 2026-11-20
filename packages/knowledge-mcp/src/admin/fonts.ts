/**
 * Fonts the person adds in the console, kept in fonts/ beside the settings. The Notes page shows a note in one of
 * them and prints it, or saves it as a PDF, with it: what a note looks like is the person's to choose.
 *
 * Only font files are taken: TrueType, OpenType and WOFF, recognised by their first bytes, not by their name. The
 * name comes from a browser, so it is one plain file name, never a path, and nothing is written through a link.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FONTS = 'fonts';
export const fontsDir = (dir: string): string => join(resolve(dir), FONTS);
export const MAX_FONT_BYTES = 20_000_000;

const KINDS: Record<string, { type: string; magic: (b: Buffer) => boolean }> = {
  ttf: { type: 'font/ttf', magic: (b) => b.readUInt32BE(0) === 0x00010000 || b.subarray(0, 4).toString('latin1') === 'true' },
  otf: { type: 'font/otf', magic: (b) => b.subarray(0, 4).toString('latin1') === 'OTTO' || b.readUInt32BE(0) === 0x00010000 },
  woff: { type: 'font/woff', magic: (b) => b.subarray(0, 4).toString('latin1') === 'wOFF' },
  woff2: { type: 'font/woff2', magic: (b) => b.subarray(0, 4).toString('latin1') === 'wOF2' },
};
const extOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** A font's file name, checked: one plain name with a font extension. Throws what is wrong with it. */
export function fontName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (!name || name.length > 120 || /[\\/\0-\x1f\x7f]/.test(name) || name.startsWith('.') || name === '..') throw new Error('Give the font a plain file name.');
  if (!KINDS[extOf(name)]) throw new Error('Fonts are .ttf, .otf, .woff or .woff2 files.');
  return name;
}

export interface FontFile {
  /** The file name. */
  file: string;
  /** The name the page gives it: the file name without its extension. */
  family: string;
  size: number;
  type: string;
}

export function listFonts(dir: string): FontFile[] {
  const root = fontsDir(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && KINDS[extOf(e.name)] && !e.name.startsWith('.'))
    .map((e) => ({ file: e.name, family: e.name.replace(/\.[^.]+$/, ''), size: statSync(join(root, e.name)).size, type: KINDS[extOf(e.name)].type }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

export function saveFont(dir: string, rawName: string, bytes: Buffer): FontFile {
  const name = fontName(rawName);
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) throw new Error(`A font is at most ${MAX_FONT_BYTES / 1_000_000} MB.`);
  if (!KINDS[extOf(name)].magic(bytes)) throw new Error(`${name} is not a ${extOf(name).toUpperCase()} font.`);
  const root = fontsDir(dir);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error('The fonts folder is a link. Fonts are not written through links.');
  const file = join(root, name);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${name} is a link. Fonts are not written through links.`);
  writeFileSync(file, bytes);
  return listFonts(dir).find((f) => f.file === name)!;
}

export function readFont(dir: string, rawName: string): { bytes: Buffer; type: string } | null {
  const name = fontName(rawName);
  const file = join(fontsDir(dir), name);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return null;
  return { bytes: readFileSync(file), type: KINDS[extOf(name)].type };
}

export function removeFont(dir: string, rawName: string): boolean {
  const file = join(fontsDir(dir), fontName(rawName));
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
