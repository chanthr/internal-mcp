/**
 * Extracts body text from Word (.docx) and PowerPoint (.pptx) with no dependencies, reading only the zip and the XML.
 *
 * Why do it directly: docx used to go through mammoth and pptx through officeparser. Even the latest mammoth pulls in
 * argparse → sprintf-js (security advisory), officeparser 7 pulls in a vulnerable pdfjs-dist, and 8 even pulls in an
 * OCR engine (tesseract.js), so every install showed warnings. Indexing needs only the body text, so reading the zip
 * listing and the text nodes of the XML is enough.
 *
 *   docx: in word/document.xml, text (<w:t>), tabs and line breaks per paragraph (<w:p>), with a blank line between
 *         paragraphs (same shape as mammoth extractRawText)
 *   pptx: ppt/slides/slideN.xml in number order, text (<a:t>) per paragraph (<a:p>). The SmartArt and chart text and
 *         the speaker notes of that slide are found through the relationship file (_rels) and appended
 *
 * Zip bomb defense: stops when one entry exceeds MAX_ENTRY_BYTES or the total exceeds MAX_TOTAL_BYTES.
 */
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Central directory listing. ZIP64 is not handled because Office documents do not use it (under 4GB). */
function listEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: 0x06054b50, located within the last 64KB (comment) + 22 bytes of the file at most.
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`corrupt zip entry ${e.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${e.name}`);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`unsupported zip compression ${e.method} in ${e.name}`);
}

/** Read the named entries (exact names) as UTF-8 text. Missing names are left out. */
export function readZipTexts(buf: Buffer, wanted: (name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  let total = 0;
  for (const e of listEntries(buf)) {
    if (!wanted(e.name)) continue;
    const data = readEntry(buf, e);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('zip content too large');
    out.set(e.name, data.toString('utf8'));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

/**
 * Paragraph texts of one XML part. `ns` is the text namespace prefix: "w" for Word, "a" for DrawingML.
 * Inside a paragraph: <ns:t> text, <ns:tab/> → tab, <ns:br/> and <w:cr/> → newline. Empty paragraphs are kept
 * as "" so callers can decide how to join them.
 */
export function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const out: string[] = [];
  const paraRe = new RegExp(`<${ns}:p[\\s>][\\s\\S]*?</${ns}:p>|<${ns}:p/>`, 'g');
  const tokenRe = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:t(?:\\s[^>]*)?/>|<${ns}:tab/>|<${ns}:br(?:\\s[^>]*)?/?>|<w:cr/>`, 'g');
  for (const para of xml.match(paraRe) ?? []) {
    let text = '';
    for (const m of para.matchAll(tokenRe)) {
      if (m[1] !== undefined) text += decodeXml(m[1]);
      else if (m[0].startsWith(`<${ns}:tab`)) text += '\t';
      else if (m[0].startsWith(`<${ns}:br`) || m[0] === '<w:cr/>') text += '\n';
    }
    out.push(text);
  }
  return out;
}

/** .docx → plain text, paragraphs separated by a blank line. */
export function docxText(buf: Buffer): string {
  const xml = readZipTexts(buf, (n) => n === 'word/document.xml').get('word/document.xml');
  if (xml === undefined) throw new Error('word/document.xml not found (not a .docx?)');
  return paragraphs(xml, 'w')
    .filter((p) => p.trim())
    .join('\n\n');
}

const slideNo = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/** Non-empty paragraph lines of one DrawingML part. */
const lines = (xml: string | undefined) => (xml ? paragraphs(xml, 'a').filter((p) => p.trim()) : []);

/**
 * .pptx → "## Slide N" sections: the slide's text, then text of SmartArt diagrams and charts on that slide,
 * then speaker notes. Diagrams, charts and notes are found through the slide's relationship file
 * (ppt/slides/_rels/slideN.xml.rels), so they stay with the right slide even when numbering differs.
 */
export function pptxText(buf: Buffer): string {
  const parts = readZipTexts(buf, (n) =>
    /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml|diagrams\/data\d+\.xml|charts\/chart\d+\.xml)$/.test(n),
  );
  const slides = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  if (!slides.length) throw new Error('no slides found (not a .pptx?)');
  return slides
    .map((name) => {
      const n = slideNo(name);
      const rels = parts.get(`ppt/slides/_rels/slide${n}.xml.rels`) ?? '';
      const targets = [...rels.matchAll(/Target="\.\.\/((?:diagrams\/data|charts\/chart|notesSlides\/notesSlide)\d+\.xml)"/g)].map((m) => `ppt/${m[1]}`);
      const notesPart = targets.find((t) => t.includes('notesSlides/')) ?? `ppt/notesSlides/notesSlide${n}.xml`;
      const body = [
        ...lines(parts.get(name)),
        ...targets.filter((t) => !t.includes('notesSlides/')).flatMap((t) => lines(parts.get(t))),
      ].join('\n');
      // Drop the slide number placeholder of the notes frame (a paragraph with digits only)
      const notes = lines(parts.get(notesPart))
        .filter((p) => !/^\d+$/.test(p.trim()))
        .join('\n');
      return [`## Slide ${n}`, body, notes ? `Notes:\n${notes}` : ''].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
}
