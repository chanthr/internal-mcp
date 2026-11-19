/**
 * Reading scanned PDFs and images (OCR) from the console: which OCR reads them, fetching a model into Ollama on
 * this computer, and reading the files that wait (server: plugins/drive/ocr.ts, plugins/knowledge/ocr_run.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { call, type Changed } from '../api';
import { AskFirst, Row, Section, useAction, useServer } from '../app';
import { hostOf, num, plural } from '../format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import { TextField } from '../ui/text-field';

interface OcrRun {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  page: { done: number; total: number } | null;
  read: number;
  pages: number;
  empty: number;
  failed: Array<{ name: string; why: string }>;
  stopped: string | null;
  startedAt: number;
  endedAt: number | null;
}
interface Pull {
  model: string;
  running: boolean;
  status: string;
  completed: number;
  total: number;
  error: string | null;
}
interface OcrStatus {
  waiting: number;
  run: OcrRun | null;
  /** Models in Ollama on this computer, or null when Ollama does not answer. */
  installed: string[] | null;
  pull: Pull | null;
}

/**
 * Models offered for this computer. Measured on 16 Korean PDF pages whose text is known (their text layer), drawn
 * as images and read through Ollama on an Apple Silicon Mac: characters wrong after spaces and Markdown are taken
 * out, median per page. deepseek-ocr:3b was measured too and is not offered: 5 of the 16 pages came back as a
 * phrase repeated without end.
 */
const LOCAL_MODELS: Array<{ model: string; size: string; note: string }> = [
  { model: 'qwen3-vl:8b-instruct', size: '6.1 GB', note: 'Read Korean pages best in our test: about 1 character in 100 wrong. About 15 seconds a page.' },
  { model: 'glm-ocr:q8_0', size: '1.8 GB', note: 'Smaller and three times as fast, about 5 seconds a page. About 1 character in 10 wrong on Korean pages.' },
];
const HF_BASE = 'https://router.huggingface.co/v1';
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** What reading scans stands at: the files waiting, the run going on, models in Ollama. Read again while it moves. */
function useOcr() {
  const { state } = useServer();
  const o = state.services.ocr;
  const [s, setS] = useState<OcrStatus | null>(null);
  const load = useCallback(() => call<OcrStatus>('GET', '/ocr').then(setS, () => undefined), []);
  useEffect(() => void load(), [load, o.set, o.model, state.folders.length]);
  const running = !!s?.run?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1200);
    return () => clearInterval(timer);
  }, [running, load]);
  return { s, load, running };
}

/** Models page: which model reads scans, set up and turned off here. */
export function ScanModel() {
  const { state, apply } = useServer();
  const o = state.services.ocr;
  const { s, load, running } = useOcr();
  const [open, setOpen] = useState(false);
  const act = useAction();
  const off = useAction();
  if (!s) return null;
  const where = !o.set ? null : o.kind === 'mathpix' ? 'Mathpix' : o.local ? 'On this computer' : hostOf(o.baseUrl);
  return (
    <Section title="Reading scans" text="Scanned PDFs and images have no text to search until a model reads it from the page (OCR).">
      <div className="rows">
        <Row
          title={
            o.set ? (
              <>
                {o.model} {where && <Badge size="sm">{where}</Badge>}
              </>
            ) : (
              'Off'
            )
          }
          help={
            <span className={act.error || off.error ? 'error' : undefined}>
              {act.error ?? off.error ?? (o.set ? 'Scans are read from the Documents page.' : 'A model on this computer through Ollama, Hugging Face, another endpoint, or Mathpix.')}
            </span>
          }
        >
          {o.set && !running && (
            <AskFirst
              label="Turn off"
              title="Turn off reading scans?"
              text="Scans read so far stay searchable. New ones are left out, and the OCR settings are deleted from .env."
              confirm="Turn off"
              disabled={off.busy}
              onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', '/services/ocr')))}
            />
          )}
          <Button size="sm" variant="secondary" disabled={!state.editable || running} onClick={() => setOpen(true)}>{o.set ? 'Change' : 'Set up'}</Button>
        </Row>
        {o.set && o.local && (
          <div className="row-form">
            <Switch
              size="sm"
              label="Read new scans after each folder scan"
              description="On this computer nothing is billed, but reading takes seconds a page and keeps the computer busy meanwhile."
              checked={o.auto}
              disabled={!state.editable}
              onChange={(e) => void act.run(() => apply(() => call<Changed>('POST', '/ocr/auto', { on: e.target.checked })))}
            />
          </div>
        )}
      </div>
      {open && <SetUp status={s} reload={load} onClose={() => setOpen(false)} />}
    </Section>
  );
}

/** Documents page: the scanned files waiting to be read, and reading them. */
export function ScannedFiles() {
  const { state, go } = useServer();
  const o = state.services.ocr;
  const { s, load, running } = useOcr();
  const act = useAction();
  // Nothing scanned and nothing set up: nothing to say.
  if (!s || (!o.set && s.waiting === 0 && !s.run)) return null;

  const run = s.run;
  const last = run && !run.running ? run : null;
  const help = running && run ? (
    <>
      Reading {num(Math.min(run.done + 1, run.total))} of {plural(run.total, 'file')}
      {run.current ? `: ${run.current}` : ''}
      {run.page && run.page.total > 1 ? `, page ${Math.min(run.page.done + 1, run.page.total)} of ${run.page.total}` : ''}
    </>
  ) : (
    <>
      {s.waiting > 0 ? `${plural(s.waiting, 'file')} with no text: scans or images.` : 'No scanned files are waiting.'}
      {!o.set && s.waiting > 0 && ' They are left out of search until a model reads their text.'}
      {last && (
        <span className="row-note">
          Last run: {plural(last.read, 'file')} read ({plural(last.pages, 'page')}){last.empty ? `, ${last.empty} with nothing found` : ''}
          {last.endedAt ? ` in ${num(Math.max(1, Math.round((last.endedAt - last.startedAt) / 1000)))} s` : ''}.{last.stopped ? ` ${last.stopped}` : ''}
        </span>
      )}
      {last && last.failed.length > 0 && (
        <span className="row-note error">
          Not read: {last.failed.slice(0, 2).map((f) => `${f.name} (${f.why})`).join('; ')}
          {last.failed.length > 2 ? ` and ${last.failed.length - 2} more` : ''}
        </span>
      )}
    </>
  );

  return (
    <Section title="Scanned files" text={o.set ? `Read by ${o.model}.` : 'Scanned PDFs and images have no text to search until it is read from the page (OCR).'}>
      <div className="rows">
        <Row title={running ? 'Reading' : s.waiting > 0 ? 'Waiting to be read' : 'All read'} help={<span className={act.error ? 'error' : undefined}>{act.error ?? help}</span>}>
          {running ? (
            <>
              <Spinner />
              <Button size="sm" variant="ghost" onClick={() => void call('POST', '/ocr/stop').then(load, load)}>Stop</Button>
            </>
          ) : !o.set ? (
            <Button size="sm" variant="secondary" onClick={() => go('models')}>Choose a model</Button>
          ) : (
            s.waiting > 0 && (
              <Button size="sm" loading={act.busy} onClick={() => void act.run(async () => { await call('POST', '/ocr/run', {}); await load(); })}>
                Read {plural(s.waiting, 'file')}
              </Button>
            )
          )}
        </Row>
      </div>
    </Section>
  );
}

type Way = 'local' | 'hf' | 'other' | 'mathpix';

function SetUp({ status, reload, onClose }: { status: OcrStatus; reload: () => Promise<unknown>; onClose: () => void }) {
  const { state, apply } = useServer();
  const o = state.services.ocr;
  const initial: Way = o.kind === 'mathpix' ? 'mathpix' : !o.set || o.local ? 'local' : o.baseUrl?.startsWith(HF_BASE) ? 'hf' : 'other';
  const [way, setWay] = useState<Way>(initial);
  const [model, setModel] = useState(o.set && o.kind === 'model' && initial === way ? o.model ?? '' : LOCAL_MODELS[0].model);
  const [baseUrl, setBaseUrl] = useState(initial === 'other' ? o.baseUrl ?? '' : '');
  const [apiKey, setApiKey] = useState('');
  const [appId, setAppId] = useState('');
  const [appKey, setAppKey] = useState('');
  const save = useAction();
  const fetchModel = useAction();
  const installed = status.installed;
  const pull = status.pull;
  const pulling = !!pull?.running;
  // While a model is fetched, read how far it is.
  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => void reload(), 1000);
    return () => clearInterval(timer);
  }, [pulling, reload]);

  const has = (m: string) => !!installed?.some((i) => i === m || i === `${m}:latest`);
  const choose = (w: Way) => {
    setWay(w);
    setModel(w === 'local' ? LOCAL_MODELS[0].model : '');
    save.clear();
  };
  const base = way === 'local' ? 'http://localhost:11434/v1' : way === 'hf' ? HF_BASE : baseUrl.trim();
  const keySaved = o.keySet && o.baseUrl === base;
  const ready =
    way === 'mathpix'
      ? appId.trim().length > 1 && appKey.trim().length > 9
      : model.trim().length > 1 && (way !== 'local' || has(model.trim())) && (way !== 'hf' || apiKey.trim().length > 9 || keySaved) && (way !== 'other' || base.length > 8);

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !save.busy && onClose()}
      title="Read scanned files"
      description="A model that reads images writes out the text of each page. The setting is saved in .env on this machine."
      footer={
        <>
          <Button variant="ghost" disabled={save.busy} onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!ready || pulling}
            onClick={() =>
              void save.run(async () => {
                await apply(() =>
                  call<Changed>(
                    'POST',
                    '/services/ocr',
                    way === 'mathpix' ? { provider: 'mathpix', appId: appId.trim(), appKey: appKey.trim() } : { provider: 'model', baseUrl: base, model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
                  ),
                );
                onClose();
              })
            }
          >
            {way === 'mathpix' ? 'Save' : 'Check and save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <SegmentedControl<Way>
          aria-label="Where the OCR runs"
          variant="tray"
          value={way}
          onChange={choose}
          options={[
            { value: 'local', label: 'This computer' },
            { value: 'hf', label: 'Hugging Face' },
            { value: 'other', label: 'Another endpoint' },
            { value: 'mathpix', label: 'Mathpix' },
          ]}
        />
        {way === 'local' &&
          (installed === null ? (
            <p className="field-help">
              Ollama is not running on this computer. Install it from ollama.com and start it, then open this again. The models below are fetched through it.
            </p>
          ) : (
            <>
              <div className="rows">
                {LOCAL_MODELS.map((m) => (
                  <Row
                    key={m.model}
                    title={
                      <label className="radio-line">
                        <input type="radio" name="ocr-model" checked={model === m.model} onChange={() => setModel(m.model)} /> <span className="mono">{m.model}</span>
                      </label>
                    }
                    help={
                      pull?.model === m.model && (pull.running || pull.error)
                        ? pull.error ?? `${pull.status}${pull.total ? `: ${gb(pull.completed)} of ${gb(pull.total)}` : ''}`
                        : `${m.note} ${m.size}.`
                    }
                  >
                    {has(m.model) ? (
                      <Badge size="md" tone="success">Installed</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={pull?.model === m.model && pull.running}
                        disabled={pulling}
                        onClick={() => void fetchModel.run(async () => { await call('POST', '/ocr/pull', { model: m.model }); await reload(); })}
                      >
                        Install
                      </Button>
                    )}
                  </Row>
                ))}
              </div>
              <p className="field-help">Pages never leave this computer, and nothing is billed. Another model Ollama has can be typed below.</p>
              <TextField label="Model" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} hint={model.trim() && !has(model.trim()) ? 'Ollama does not have this model yet.' : undefined} />
            </>
          ))}
        {way === 'hf' && (
          <>
            <TextField label="Hugging Face token" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" hint={keySaved ? 'A token is saved. Leave this empty to keep it.' : 'A fine-grained token with "Make calls to Inference Providers". Billed by Hugging Face.'} />
            <TextField label="Model" placeholder="Qwen/Qwen3-VL-8B-Instruct" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} hint="A model that reads images, as Hugging Face names it. Pages are sent to Hugging Face and the partner that runs it." />
          </>
        )}
        {way === 'other' && (
          <>
            <TextField label="API address" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} hint="An API that speaks OpenAI's chat completions and takes images: OpenRouter, vLLM, LM Studio." />
            <TextField label="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" hint={keySaved ? 'A key is saved for this address. Leave this empty to keep it.' : 'Leave empty if the address needs none.'} />
            <TextField label="Model" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
          </>
        )}
        {way === 'mathpix' && (
          <>
            <TextField label="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" spellCheck={false} />
            <TextField label="App key" type="password" value={appKey} onChange={(e) => setAppKey(e.target.value)} autoComplete="off" hint="Mathpix bills per page. The keys are not tried before saving: a test would be billed." />
          </>
        )}
        {way !== 'mathpix' && <p className="field-help">Before saving, one test page is read: the model has to read it back.</p>}
        {(save.error || fetchModel.error) && <p className="error" role="alert">{save.error ?? fetchModel.error}</p>}
      </div>
    </Dialog>
  );
}
