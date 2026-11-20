/**
 * Notes: what the chat saved for the person (notes/) and what other assistants and programs sent (inbox/), read in
 * a font of the person's choosing, and printed or saved as a PDF from the browser (server: plugins/knowledge/notes.ts,
 * admin/fonts.ts).
 *
 * A font added here is kept in fonts/ beside the settings. The page loads it with the console token (FontFace), so
 * it needs no address of its own. Which font a note is shown in is remembered in this browser only.
 */
import { useEffect, useRef, useState } from 'react';
import { call, token } from '../api';
import { AskFirst, Page, Row, Section, useAction, useServer } from '../app';
import { Markdown } from '../markdown';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { plural } from '../format';

interface NoteEntry {
  place: 'notes' | 'inbox';
  path: string;
  title: string;
  date: string | null;
  from: string | null;
  modified: string;
  size: number;
}
interface FontFile {
  file: string;
  family: string;
  size: number;
}

const FONT_KEY = 'kmcp.noteFont';
const remembered = (): string => {
  try {
    return localStorage.getItem(FONT_KEY) ?? '';
  } catch {
    return '';
  }
};
const remember = (family: string) => {
  try {
    localStorage.setItem(FONT_KEY, family);
  } catch {
    /* a browser that keeps nothing: the choice lasts this visit */
  }
};
/** The font as the page knows it: its own name, so it cannot clash with a font of the system. */
const faceName = (family: string) => `note-${family}`;

/** Load a font file into the page, with the console token. */
async function loadFont(f: FontFile, loaded: Set<string>): Promise<void> {
  if (loaded.has(f.family)) return;
  const res = await fetch(`./api/fonts/${encodeURIComponent(f.file)}`, { headers: { Authorization: `Bearer ${token() ?? ''}` } });
  if (!res.ok) return;
  const face = new FontFace(faceName(f.family), await res.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  loaded.add(f.family);
}

export function Notes() {
  const { state } = useServer();
  const [notes, setNotes] = useState<NoteEntry[] | null>(null);
  const [fonts, setFonts] = useState<FontFile[]>([]);
  const [font, setFont] = useState(remembered);
  const [open, setOpen] = useState<{ note: NoteEntry; text: string } | null>(null);
  const loaded = useRef(new Set<string>());
  const read = useAction();
  const upload = useAction();
  const file = useRef<HTMLInputElement>(null);

  const loadFonts = () => call<{ fonts: FontFile[] }>('GET', '/fonts').then((r) => setFonts(r.fonts), () => setFonts([]));
  useEffect(() => {
    void call<{ notes: NoteEntry[] }>('GET', '/notes').then((r) => setNotes(r.notes), () => setNotes([]));
    void loadFonts();
  }, []);
  useEffect(() => {
    for (const f of fonts) void loadFont(f, loaded.current).catch(() => undefined);
  }, [fonts]);

  const openNote = (n: NoteEntry) =>
    void read.run(async () => {
      const r = await call<{ text: string }>('GET', `/notes/file?place=${n.place}&path=${encodeURIComponent(n.path)}`);
      setOpen({ note: n, text: r.text });
      requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    });
  const addFont = (f: File) =>
    void upload.run(async () => {
      const res = await fetch(`./api/fonts/${encodeURIComponent(f.name)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token() ?? ''}`, 'Content-Type': 'application/octet-stream' }, body: f });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fonts?: FontFile[]; font?: FontFile };
      if (!res.ok) throw new Error(body.error ?? `The font was not added (${res.status}).`);
      setFonts(body.fonts ?? []);
      if (body.font) choose(body.font.family);
    });
  const choose = (family: string) => {
    setFont(family);
    remember(family);
  };
  const usable = fonts.some((f) => f.family === font) ? font : '';

  return (
    <Page title="Notes" text="What the chat saved for you, and what other assistants and programs sent. Shown in a font you choose, and printed or saved as a PDF.">
      {open && (
        <Section
          title={open.note.title}
          text={`${open.note.place}/${open.note.path}${open.note.from ? ` · from ${open.note.from}` : ''}`}
          action={
            <div className="actions">
              <div className="note-font">
                <Select
                  size="sm"
                  aria-label="Font"
                  value={usable || 'system'}
                  onChange={(v) => choose(v === 'system' ? '' : v)}
                  options={[{ value: 'system', label: 'The console font' }, ...fonts.map((f) => ({ value: f.family, label: f.family }))]}
                />
              </div>
              <Button size="sm" variant="secondary" onClick={() => window.print()}>Print or save as PDF</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
            </div>
          }
        >
          <article className="md note-print" style={usable ? { fontFamily: `"${faceName(usable)}", var(--font, system-ui)` } : undefined}>
            <Markdown text={open.text.replace(/^---\n[\s\S]*?\n---\n?/, '')} />
          </article>
        </Section>
      )}
      <Section title="Notes" text={notes && notes.length ? plural(notes.length, 'note') : undefined}>
        <div className="rows">
          {notes?.length === 0 && <Row title="No notes yet" help="Ask the chat to keep something: notes on a document, a summary. Other assistants and programs can send notes too." />}
          {notes?.map((n) => (
            <Row key={`${n.place}/${n.path}`} title={n.title} help={`${n.place}/${n.path}${n.date ? ` · ${n.date}` : ''}${n.place === 'inbox' && n.from ? ` · from ${n.from}` : ''}`}>
              <Button size="sm" variant="secondary" loading={read.busy && open === null} onClick={() => openNote(n)}>Open</Button>
            </Row>
          ))}
        </div>
        {read.error && <p className="error" role="alert">{read.error}</p>}
      </Section>
      <Section title="Fonts" text="Fonts you add are kept in fonts/ beside your settings: TrueType, OpenType or WOFF files.">
        <div className="rows">
          {fonts.map((f) => (
            <Row key={f.file} title={<span style={{ fontFamily: `"${faceName(f.family)}"` }}>{f.family}</span>} help={`${f.file} · ${Math.max(1, Math.round(f.size / 1024))} KB`}>
              <AskFirst label="Remove" title={`Remove ${f.family}?`} text="The font file is deleted from fonts/ on this computer." confirm="Remove" disabled={!state.editable} onConfirm={async () => setFonts((await call<{ fonts: FontFile[] }>('DELETE', `/fonts/${encodeURIComponent(f.file)}`)).fonts)} />
            </Row>
          ))}
          <Row title="Add a font" help="A .ttf, .otf, .woff or .woff2 file, up to 20 MB.">
            <input
              ref={file}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) addFont(f);
                e.target.value = '';
              }}
            />
            <Button size="sm" variant="secondary" loading={upload.busy} disabled={!state.editable} onClick={() => file.current?.click()}>Choose a file</Button>
          </Row>
        </div>
        {upload.error && <p className="error" role="alert">{upload.error}</p>}
      </Section>
    </Page>
  );
}
