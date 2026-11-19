/**
 * How documents are cut into passages and what the embedding model reads (server: index_profile.ts), and
 * measuring what search finds on these documents (server: measure.ts).
 *
 * There is no one right way: it depends on the documents. So the page offers the ways that were measured, lets
 * the person compare them on their own documents, and keeps the default when nothing is chosen.
 */
import { useCallback, useEffect, useState } from 'react';
import { call, type Changed, type State } from '../api';
import { Row, Section, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AlertDialog, Dialog } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { TextField } from '../ui/text-field';

type Profile = NonNullable<NonNullable<State['index']>['profile']>;
type Cut = Profile['cut'];
type Header = Profile['header'];

interface ModeScore {
  first: number;
  top3: number;
  top10: number;
  mrr: number;
}
interface Measured {
  at: string;
  cut: string;
  model: string | null;
  documents: number;
  passages: number;
  questions: number;
  modes: { keyword: ModeScore | null; meaning: ModeScore | null; both: ModeScore | null };
  note: string | null;
}
interface Compared {
  at: string;
  model: string;
  documents: number;
  questions: number;
  ways: Array<{ cut: string; passages: number; score: ModeScore }>;
}
interface MeasureView {
  questions: number;
  canWrite: boolean;
  measured: Measured[];
  compared: Compared | null;
  run: { running: boolean; what: 'measure' | 'compare'; phase: 'questions' | 'asking' | 'embedding'; done: number; total: number; way: string | null; error: string | null } | null;
  file: string;
  ways: Array<{ cut: Cut; maxTokens: number }>;
}

/** "sections:800:50:100" → the way in words. */
function wayName(cut: Cut, maxTokens: number): string {
  return cut === 'sections' ? `At headings, up to ${maxTokens.toLocaleString()} tokens` : `By length, ${maxTokens.toLocaleString()} tokens, headings ignored`;
}
function parseMark(mark: string): { cut: Cut; maxTokens: number } | null {
  const [cut, tokens] = mark.split(':');
  const maxTokens = Number(tokens);
  return (cut === 'sections' || cut === 'windows') && Number.isInteger(maxTokens) ? { cut, maxTokens } : null;
}
const isDefault = (p: Pick<Profile, 'cut' | 'maxTokens'>) => p.cut === 'sections' && p.maxTokens === 800;
const HEADERS: Array<{ value: Header; label: string }> = [
  { value: 'heading', label: 'Its headings (default)' },
  { value: 'document', label: "The document's name and its headings" },
  { value: 'none', label: 'The passage alone' },
];
const count = (n: number) => n.toLocaleString();
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '');

export function Passages() {
  const { state, refresh } = useServer();
  const i = state.index;
  const e = state.services.embeddings;
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<MeasureView | null>(null);
  const remake = useAction();
  const act = useAction();
  const load = useCallback(() => call<MeasureView>('GET', '/index/measure').then(setM, () => undefined), []);
  useEffect(() => void load(), [load]);
  const running = !!m?.run?.running;
  const cutting = (i?.recut ?? 0) > 0;
  // While something moves, read it again: the measuring here, the cutting through the folder scan.
  useEffect(() => {
    if (!running && !cutting) return;
    const timer = setInterval(() => {
      void load();
      if (cutting) void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [running, cutting, load, refresh]);

  if (!i?.profile) return null;
  const p = i.profile;
  const start = (what: 'measure' | 'compare', fresh = false) => void act.run(async () => setM(await call<MeasureView>('POST', '/index/measure', { what, fresh })));

  const status = cutting
    ? `Cutting ${count(i.recut ?? 0)} document${i.recut === 1 ? '' : 's'} the new way. Search works meanwhile.`
    : `${count(i.chunks)} passages from ${count(i.documents)} documents.`;
  const reads = p.header === 'heading' ? 'The embedding model also reads the headings above each passage.' : p.header === 'document' ? "The embedding model also reads the document's name and the headings above each passage." : 'The embedding model reads each passage alone.';
  const prefix =
    p.prefixFrom === 'model'
      ? `${e.model} gets the ${p.passagePrefix ? 'prefixes' : 'instruction'} it was trained with${p.passagePrefix ? '' : ' before each question'}.`
      : p.prefixFrom === 'settings'
        ? 'Prefixes set by you are used.'
        : null;

  return (
    <Section title="Passages" text="How documents are cut for search. Which way finds most depends on the documents: compare them on yours.">
      <div className="rows">
        <Row
          title={
            <>
              {wayName(p.cut, p.maxTokens)}
              {isDefault(p) && <span className="muted"> (default)</span>}
            </>
          }
          help={
            <>
              {status} {e.set && reads} {e.set && prefix}
              {i.behind && <span className="row-note">The setting changed what the embedding model reads. Search uses the vectors made before until new ones are made.</span>}
              {remake.error && <span className="row-note error">{remake.error}</span>}
            </>
          }
        >
          {cutting && <Spinner />}
          {i.behind && !i.job?.running && (
            <AlertDialog
              trigger={<Button size="sm">Make new vectors</Button>}
              title={`Make new vectors for ${count(i.chunks)} passages?`}
              description={`The text of every passage is sent to ${e.model ?? 'the embedding model'}. No document is read again, and search works by keywords meanwhile.`}
              confirmLabel="Make new vectors"
              onConfirm={() => remake.run(async () => void (await call('POST', '/index/reembed'), await refresh()))}
            />
          )}
          <Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setOpen(true)}>Change</Button>
        </Row>
        {m && <Measure m={m} e={e} p={p} running={running} start={start} stop={() => void call<MeasureView>('POST', '/index/measure/stop').then(setM, load)} busy={act.busy} error={act.error} />}
      </div>
      {open && <ChangeWay p={p} onClose={() => setOpen(false)} />}
    </Section>
  );
}

function Measure({
  m,
  e,
  p,
  running,
  start,
  stop,
  busy,
  error,
}: {
  m: MeasureView;
  e: State['services']['embeddings'];
  p: Profile;
  running: boolean;
  start: (what: 'measure' | 'compare', fresh?: boolean) => void;
  stop: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { apply, state } = useServer();
  const use = useAction();
  const run = m.run;
  const ready = m.questions >= 5 || m.canWrite;
  const progress = run?.running
    ? run.phase === 'questions'
      ? `Writing questions from your documents: ${count(run.done)} of ${count(run.total)}.`
      : run.phase === 'embedding'
        ? `Embedding the sample cut ${run.way ? wayName(parseMark(run.way)?.cut ?? 'sections', parseMark(run.way)?.maxTokens ?? 0).toLowerCase() : ''}: ${count(run.done)} of ${count(run.total)} passages.`
        : `Asking ${count(run.total)} questions: ${count(run.done)} done.`
    : null;
  const help = !ready
    ? `Measuring asks questions whose answer is known. Connect a model on the Agent page and it writes them from your documents, or write your own in ${m.file}.`
    : m.questions >= 5
      ? `${count(m.questions)} questions, each with the document that answers it. The same ones are asked every time, so results can be set side by side.`
      : 'The connected model first writes about 40 questions from your documents. The same ones are then asked every time.';
  const last = m.measured[0] ?? null;
  const prev = m.measured[1] ?? null;
  const both = (x: Measured | null) => x?.modes.both ?? null;
  const useWay = (w: { cut: Cut; maxTokens: number }) =>
    void use.run(() => apply(() => call<Changed>('POST', '/index/profile', { cut: w.cut, maxTokens: w.maxTokens, header: p.header, ...(p.prefixFrom === 'settings' ? { queryPrefix: p.queryPrefix, passagePrefix: p.passagePrefix } : {}) })));

  return (
    <>
      <Row title="Measure on your documents" help={<span className={run?.error && !run.running ? 'error' : undefined}>{progress ?? run?.error ?? help}</span>}>
        {running ? (
          <>
            <Spinner />
            <Button size="sm" variant="ghost" onClick={stop}>Stop</Button>
          </>
        ) : (
          <>
            {m.questions >= 5 && m.canWrite && (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => start('measure', true)}>New questions</Button>
            )}
            <Button size="sm" variant="secondary" loading={busy} disabled={!ready} onClick={() => start('measure')}>Measure search</Button>
            <Button size="sm" variant="secondary" loading={busy} disabled={!ready || !e.set} onClick={() => start('compare')}>Compare ways</Button>
          </>
        )}
      </Row>
      {error && <p className="error" role="alert">{error}</p>}
      {use.error && <p className="error" role="alert">{use.error}</p>}
      {last && (
        <div className="row-form">
          <p className="field-help">
            Search as it is, {new Date(last.at).toLocaleString()}: the right document among the first three for {count(last.modes.both?.top3 ?? 0)} of {count(last.questions)} questions
            {prev && both(prev) && both(last) ? ` (before: ${count(both(prev)!.top3)}, ${parseMark(prev.cut) ? wayName(parseMark(prev.cut)!.cut, parseMark(prev.cut)!.maxTokens).toLowerCase() : prev.cut})` : ''}.
            {last.note ? ` Meaning was not measured: ${last.note}.` : ''}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Search by</th>
                <th>First</th>
                <th>In the first 3</th>
                <th>In the first 10</th>
              </tr>
            </thead>
            <tbody>
              {(['both', 'keyword', 'meaning'] as const).map((k) => {
                const s = last.modes[k];
                return (
                  <tr key={k}>
                    <td>{k === 'both' ? 'Both, as search does' : k === 'keyword' ? 'Keywords' : 'Meaning'}</td>
                    <td className="muted">{s ? `${count(s.first)} (${pct(s.first, last.questions)})` : 'Not measured'}</td>
                    <td className="muted">{s ? `${count(s.top3)} (${pct(s.top3, last.questions)})` : ''}</td>
                    <td className="muted">{s ? `${count(s.top10)} (${pct(s.top10, last.questions)})` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {m.compared && (
        <div className="row-form">
          <p className="field-help">
            Ways compared on {count(m.compared.documents)} of your documents with {m.compared.model}, by meaning, {new Date(m.compared.at).toLocaleString()}. Out of {count(m.compared.questions)} questions:
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Way</th>
                <th>Passages</th>
                <th>First</th>
                <th>In the first 3</th>
                <th>In the first 10</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {m.compared.ways.map((w) => {
                const way = parseMark(w.cut);
                const inUse = !!way && way.cut === p.cut && way.maxTokens === p.maxTokens;
                return (
                  <tr key={w.cut}>
                    <td>{way ? wayName(way.cut, way.maxTokens) : w.cut}</td>
                    <td className="muted">{count(w.passages)}</td>
                    <td className="muted">{count(w.score.first)}</td>
                    <td className="muted">{count(w.score.top3)}</td>
                    <td className="muted">{count(w.score.top10)}</td>
                    <td>
                      {inUse ? (
                        <Badge size="md" tone="success">In use</Badge>
                      ) : (
                        way && <Button size="sm" variant="ghost" loading={use.busy} disabled={!state.editable} onClick={() => useWay(way)}>Use</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Choice = 'sections-800' | 'sections-400' | 'sections-250' | 'windows-400' | 'other';
const CHOICES: Array<{ value: Choice; label: string }> = [
  { value: 'sections-800', label: 'At headings, up to 800 tokens (default)' },
  { value: 'sections-400', label: 'At headings, up to 400 tokens' },
  { value: 'sections-250', label: 'At headings, up to 250 tokens' },
  { value: 'windows-400', label: 'By length, 400 tokens, headings ignored' },
  { value: 'other', label: 'Other' },
];
const choiceOf = (p: Pick<Profile, 'cut' | 'maxTokens'>): Choice => {
  const c = `${p.cut}-${p.maxTokens}` as Choice;
  return CHOICES.some((x) => x.value === c) ? c : 'other';
};

function ChangeWay({ p, onClose }: { p: Profile; onClose: () => void }) {
  const { apply, state } = useServer();
  const e = state.services.embeddings;
  const [choice, setChoice] = useState<Choice>(choiceOf(p));
  const [cut, setCut] = useState<Cut>(p.cut);
  const [tokens, setTokens] = useState(String(p.maxTokens));
  const [overlap, setOverlap] = useState(String(p.overlapTokens));
  const [header, setHeader] = useState<Header>(p.header);
  const [own, setOwn] = useState(p.prefixFrom === 'settings');
  // A field holds one line: a line break in a prefix is written as \n, and the server reads it back as one.
  const typed = (s: string) => s.replace(/\n/g, '\\n');
  const [queryPrefix, setQueryPrefix] = useState(typed(p.prefixFrom === 'settings' ? p.queryPrefix : p.modelPrefixes?.query ?? ''));
  const [passagePrefix, setPassagePrefix] = useState(typed(p.prefixFrom === 'settings' ? p.passagePrefix : p.modelPrefixes?.passage ?? ''));
  const save = useAction();

  const picked = choice === 'other' ? { cut, maxTokens: Number(tokens) } : { cut: choice.split('-')[0] as Cut, maxTokens: Number(choice.split('-')[1]) };
  const tokensOk = Number.isInteger(picked.maxTokens) && picked.maxTokens >= 100 && picked.maxTokens <= 4000;
  const overlapOk = choice !== 'other' || overlap.trim() === '' || (Number.isInteger(Number(overlap)) && Number(overlap) >= 0 && Number(overlap) < picked.maxTokens / 2);
  const shown = (s: string) => (s ? <code>{JSON.stringify(s).slice(1, -1)}</code> : 'nothing');
  const auto = p.modelPrefixes;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="How documents are cut"
      description="Documents in folders are cut again after saving; search works meanwhile. Drive documents are cut again when they change, or all at once with knowledge-mcp drive reindex."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!tokensOk || !overlapOk}
            onClick={() =>
              void save.run(async () => {
                await apply(() =>
                  call<Changed>('POST', '/index/profile', {
                    ...picked,
                    header,
                    ...(choice === 'other' && overlap.trim() !== '' ? { overlapTokens: Number(overlap) } : {}),
                    ...(own ? { queryPrefix, passagePrefix } : { queryPrefix: null, passagePrefix: null }),
                  }),
                );
                onClose();
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Select
          label="Cut documents"
          value={choice}
          onChange={(v) => setChoice(v as Choice)}
          options={CHOICES}
          hint="Measured on a wiki of 500 Markdown files: 250 to 800 tokens at headings found about the same, larger passages and cutting by length found less. Compare them on your own documents to choose."
        />
        {choice === 'other' && (
          <>
            <SegmentedControl<Cut>
              aria-label="Where passages are cut"
              variant="tray"
              value={cut}
              onChange={setCut}
              options={[
                { value: 'sections', label: 'At headings' },
                { value: 'windows', label: 'By length' },
              ]}
            />
            <div className="inline">
              <TextField label="Tokens in a passage" inputMode="numeric" value={tokens} onChange={(ev) => setTokens(ev.target.value)} error={tokensOk ? undefined : 'From 100 to 4,000.'} />
              <TextField label="Repeated from the one before" inputMode="numeric" placeholder="Automatic" value={overlap} onChange={(ev) => setOverlap(ev.target.value)} error={overlapOk ? undefined : 'Less than half a passage.'} />
            </div>
          </>
        )}
        <Select
          label="With each passage, the embedding model also reads"
          value={header}
          onChange={(v) => setHeader(v as Header)}
          options={HEADERS}
          hint={e.set ? 'Changing this needs new vectors for every passage.' : 'Used once an embedding model is set up.'}
        />
        <SegmentedControl<'auto' | 'own'>
          aria-label="Prefixes"
          variant="tray"
          value={own ? 'own' : 'auto'}
          onChange={(v) => setOwn(v === 'own')}
          options={[
            { value: 'auto', label: 'Prefixes the model was trained with' },
            { value: 'own', label: 'My own prefixes' },
          ]}
        />
        {own ? (
          <div className="stack">
            <TextField label="Before each question" value={queryPrefix} onChange={(ev) => setQueryPrefix(ev.target.value)} autoComplete="off" spellCheck={false} hint="Write \n for a line break." />
            <TextField label="Before each passage" value={passagePrefix} onChange={(ev) => setPassagePrefix(ev.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        ) : (
          <p className="field-help">
            {!e.set
              ? 'Chosen for the embedding model once one is set up.'
              : auto
                ? (
                    <>
                      {e.model}: {shown(auto.query)} before each question, {shown(auto.passage)} before each passage, as its model card says.
                    </>
                  )
                : `${e.model} needs no prefix, as far as this server knows. Some models find more with one: set it by hand from the model's card.`}
          </p>
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}
