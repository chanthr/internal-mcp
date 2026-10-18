/** Built-in .docx / .pptx text extraction (ooxml.ts): zip reading, XML text, entities, slide order, notes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { docxText, pptxText, readZipTexts, decodeXml } from '../src/plugins/drive/ooxml.js';

/** Minimal zip writer for fixtures: stored or deflated entries, CRC left 0 (the reader does not check it). */
function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

test('docx: paragraphs, runs, tabs, breaks and entities', () => {
  const xml = `<?xml version="1.0"?><w:document ${W}><w:body>
    <w:p w:rsidR="1"><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>
      <w:r><w:t>회의 </w:t></w:r><w:r><w:t xml:space="preserve">기록 &amp; 결정</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:t>항목</w:t><w:tab/><w:t>값</w:t><w:br/><w:t>다음 줄 &#x2014; &#169;</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>표 칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  for (const deflate of [true, false]) {
    const text = docxText(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }, deflate));
    assert.equal(text, '회의 기록 & 결정\n\n항목\t값\n다음 줄 — ©\n\n표 칸');
  }
});

test('pptx: slides in numeric order with speaker notes', () => {
  const slide = (t: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody ${A}><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>둘째 줄</a:t></a:r><a:br><a:rPr/></a:br><a:r><a:t>이어서</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const notes = `<p:notes><p:txBody ${A}><a:p><a:r><a:t>발표 메모</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>2</a:t></a:fld></a:p></p:txBody></p:notes>`;
  const buf = zip({
    'ppt/slides/slide10.xml': slide('열 번째'),
    'ppt/slides/slide2.xml': slide('두 번째'),
    'ppt/slides/slide1.xml': slide('첫 번째'),
    'ppt/notesSlides/notesSlide2.xml': notes,
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
  });
  const text = pptxText(buf);
  assert.deepEqual(text.match(/## Slide \d+/g), ['## Slide 1', '## Slide 2', '## Slide 10']);
  assert.match(text, /## Slide 2\n\n두 번째\n둘째 줄\n이어서\n\nNotes:\n발표 메모/);
  assert.doesNotMatch(text, /Notes:\n발표 메모\n2/); // slide-number placeholder in the notes is dropped
});

test('pptx: SmartArt, chart and notes are found through the slide relationships', () => {
  const p = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const rels = `<Relationships>
    <Relationship Id="rId1" Type=".../diagramData" Target="../diagrams/data1.xml"/>
    <Relationship Id="rId2" Type=".../chart" Target="../charts/chart3.xml"/>
    <Relationship Id="rId3" Type=".../notesSlide" Target="../notesSlides/notesSlide7.xml"/>
    <Relationship Id="rId4" Type=".../image" Target="../media/image1.png"/>
  </Relationships>`;
  const text = pptxText(
    zip({
      'ppt/slides/slide1.xml': `<p:sld><p:txBody ${A}>${p('제목')}</p:txBody></p:sld>`,
      'ppt/slides/_rels/slide1.xml.rels': rels,
      'ppt/diagrams/data1.xml': `<dgm:dataModel ${A}><dgm:pt><dgm:t>${p('도형 글자')}</dgm:t></dgm:pt></dgm:dataModel>`,
      'ppt/charts/chart3.xml': `<c:chartSpace ${A}><c:title><c:tx><c:rich>${p('매출 추이')}</c:rich></c:tx></c:title></c:chartSpace>`,
      'ppt/notesSlides/notesSlide7.xml': `<p:notes><p:txBody ${A}>${p('노트는 7번 파일')}</p:txBody></p:notes>`,
      'ppt/notesSlides/notesSlide1.xml': `<p:notes><p:txBody ${A}>${p('다른 슬라이드의 노트')}</p:txBody></p:notes>`,
    }),
  );
  assert.equal(text, '## Slide 1\n\n제목\n도형 글자\n매출 추이\n\nNotes:\n노트는 7번 파일');
});

test('not a zip, missing parts and oversized entries are errors, not crashes', () => {
  assert.throws(() => docxText(Buffer.from('plain text, not a zip')), /not a zip/);
  assert.throws(() => docxText(zip({ 'other.xml': '<x/>' })), /word\/document\.xml not found/);
  assert.throws(() => pptxText(zip({ 'ppt/presentation.xml': '<x/>' })), /no slides/);
  const bomb = zip({ 'word/document.xml': 'a'.repeat(70 * 1024 * 1024) });
  assert.throws(() => readZipTexts(bomb, () => true), /too large/);
});

test('decodeXml handles named and numeric entities and leaves unknown ones', () => {
  assert.equal(decodeXml('&lt;a&gt; &quot;b&quot; &apos;c&apos; &#65;&#x42; &nbsp;'), `<a> "b" 'c' AB &nbsp;`);
});
