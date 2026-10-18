/**
 * Word(.docx), PowerPoint(.pptx) 본문 텍스트 추출 — 의존성 없이 zip 과 XML 만 읽는다.
 *
 * 왜 직접: 예전엔 docx 는 mammoth, pptx 는 officeparser 를 썼다. mammoth 최신판도 argparse → sprintf-js
 * (보안 권고)를, officeparser 7 은 취약한 pdfjs-dist 를, 8 은 OCR 엔진(tesseract.js)까지 끌어와 설치마다
 * 경고가 났다. 색인에 필요한 건 본문 텍스트뿐이라 zip 목록과 XML 의 글자 노드만 읽으면 된다.
 *
 *   docx: word/document.xml 의 문단(<w:p>)마다 글자(<w:t>), 탭, 줄바꿈 → 문단 사이 빈 줄 (mammoth extractRawText 와 같은 모양)
 *   pptx: ppt/slides/slideN.xml 을 번호 순으로, 문단(<a:p>)마다 글자(<a:t>). 그 슬라이드의 SmartArt, 차트 글자와
 *         발표자 노트를 관계 파일(_rels)로 찾아 뒤에 붙인다
 *
 * 압축 폭탄 방어: 항목 하나 MAX_ENTRY_BYTES, 합계 MAX_TOTAL_BYTES 를 넘으면 멈춘다.
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

/** Central directory 목록. ZIP64 는 Office 문서에 쓰이지 않아(4GB 미만) 다루지 않는다. */
function listEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: 0x06054b50, 파일 끝에서 최대 64KB(주석) + 22바이트 안에 있다.
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
      // 노트 틀의 슬라이드 번호 자리(숫자만 있는 문단)는 뺀다
      const notes = lines(parts.get(notesPart))
        .filter((p) => !/^\d+$/.test(p.trim()))
        .join('\n');
      return [`## Slide ${n}`, body, notes ? `Notes:\n${notes}` : ''].filter(Boolean).join('\n\n');
    })
    .join('\n\n');
}
