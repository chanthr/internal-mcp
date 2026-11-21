/**
 * Search by meaning: which embedding model makes the vectors, and where they stand (server: core/embeddings).
 */
import { useEffect, useState } from 'react';
import { call, type Changed } from '../api';
import { AskFirst, Row, Section, useAction, useServer } from '../app';
import { isLocal, num } from '../format';
import { ModelList } from '../model-list';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AlertDialog, Dialog } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { Spinner } from '../ui/spinner';
import { TextField } from '../ui/text-field';

type Provider = 'local' | 'openai' | 'other';
const OLLAMA = 'http://localhost:11434/v1';

/**
 * Search by meaning: which embedding model, and where its vectors stand.
 * Changing the model is two steps on purpose. Saving it costs nothing; making new vectors for every passage sends
 * all the passage text to the model (and is paid for, with a paid one), so that is a button of its own.
 */
export function Meaning() {
  const { state, apply, refresh } = useServer();
  const e = state.services.embeddings;
  const i = state.index;
  const [open, setOpen] = useState(false);
  const off = useAction();
  const remake = useAction();

  const job = i?.job ?? null;
  const stale = !!(e.set && i?.problem); // the vectors in the index were made by another model
  const refused = i?.refused ?? 0;
  const waiting = i && e.set && !stale ? i.chunks - i.withVectors - refused : 0;
  const working = !!job?.running || waiting > 0;
  // While vectors are being made the numbers move: read them again every few seconds, on this page only.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const missing = (i?.chunks ?? 0) - (i?.withVectors ?? 0);
  const failing = e.set && !job?.running ? i?.vectorRun?.error ?? null : null;
  const help = !e.set
    ? i?.vectorsFrom && missing > 0
      ? `No embedding model is set, so search uses keywords only. ${num(i.withVectors)} of ${num(i.chunks)} passages already have vectors from ${i.vectorsFrom}: set it up again and the other ${num(missing)} are made by themselves.`
      : 'An embedding model on this computer, OpenAI, or another provider. The text of each passage is sent to it.'
    : failing
      ? `${num(missing)} of ${num(i?.chunks ?? 0)} passages have no vectors yet: ${failing}${i?.vectorRun?.retryAt ? ` Trying again at ${new Date(i.vectorRun.retryAt).toLocaleTimeString()}.` : ''}`
      : job?.running
      ? `Making new vectors: ${num(i?.withVectors ?? 0)} of ${num(i?.chunks ?? 0)} passages. Search works by keywords meanwhile.`
      : job?.error
        ? job.error
        : stale
          ? `Paused. The index still holds vectors made by ${i?.vectorsFrom ?? 'another model'}, and the two cannot be mixed. Search answers by keywords until new vectors are made.`
          : waiting > 0
            ? `Preparing: ${num((i?.chunks ?? 0) - waiting)} of ${num(i?.chunks ?? 0)} passages. Search works meanwhile.`
            : `Search uses keywords and meaning together.${refused ? ` The model refused ${num(refused)} passage${refused === 1 ? '' : 's'} (too long for it, for example): ${refused === 1 ? 'it is' : 'they are'} found by keywords only.` : ''}`;

  return (
    <Section title="Search by meaning" text="Also finds documents worded differently from the question.">
      <div className="rows">
        <Row title={e.set ? e.model ?? 'On' : 'Keywords only'} help={<span className={(job?.error && !job.running) || failing ? 'error' : undefined}>{off.error ?? remake.error ?? help}</span>}>
          {working && <Spinner />}
          {e.set && !stale && !working && <Badge size="md" tone="success">On</Badge>}
          {stale && !job?.running && (
            <AlertDialog
              trigger={<Button size="sm">Make new vectors</Button>}
              title={`Make new vectors for ${num(i?.chunks ?? 0)} passages?`}
              description={`The text of every passage is sent to ${e.model}${isLocal(e.baseUrl) ? ', on this machine' : ''}. No document is read again, and search works by keywords meanwhile.`}
              confirmLabel="Make new vectors"
              onConfirm={() => remake.run(async () => void (await call('POST', '/index/reembed'), await refresh()))}
            />
          )}
          {e.set && (
            <AskFirst
              label="Turn off"
              title="Turn off search by meaning?"
              text="Search goes back to keywords, and the model settings and key are deleted from .env."
              confirm="Turn off"
              disabled={off.busy}
              onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', '/services/embeddings')))}
            />
          )}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{e.set ? 'Change model' : 'Set up'}</Button>
        </Row>
      </div>
      {open && <ModelDialog onClose={() => setOpen(false)} />}
    </Section>
  );
}

/** Pick the provider and the model. The model is asked once before anything is saved. */
function ModelDialog({ onClose }: { onClose: () => void }) {
  const { state, apply } = useServer();
  const e = state.services.embeddings;
  const [provider, setProvider] = useState<Provider>(e.set ? (e.baseUrl ? (isLocal(e.baseUrl) ? 'local' : 'other') : 'openai') : 'local');
  const [baseUrl, setBaseUrl] = useState(e.baseUrl ?? OLLAMA);
  const [model, setModel] = useState(e.set ? e.model ?? '' : '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [listing, setListing] = useState<string | null>(null); // why the models could not be listed
  const save = useAction();

  const url = provider === 'openai' ? '' : baseUrl.trim();
  // What the endpoint has, so the model is picked and not typed. An endpoint that cannot list them still works:
  // the name is typed then.
  useEffect(() => {
    let current = true;
    setModels(null);
    setListing(null);
    if (provider !== 'openai' && !/^https?:\/\/\S+$/.test(url)) return;
    const timer = setTimeout(() => {
      call<{ models: string[] }>('POST', '/embeddings/models', { baseUrl: url, apiKey: apiKey || undefined })
        .then((r) => current && setModels(r.models))
        .catch((err) => current && (setModels([]), setListing(err instanceof Error ? err.message : String(err))));
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The key is left out on purpose: typing it must not ask the endpoint again on every letter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, url]);
  useEffect(() => {
    if (models?.length && !models.includes(model)) setModel(models[0]);
  }, [models, model]);

  const changes = e.set && !!state.index?.withVectors && model !== e.model;
  const ready = !!model.trim() && (provider === 'openai' ? apiKey.trim().length >= 10 || e.keySet : /^https?:\/\/\S+$/.test(url));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Search by meaning"
      description="The model is asked once to make sure it answers, then saved."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!ready}
            onClick={() =>
              void save.run(async () => {
                await apply(() => call<Changed>('POST', '/services/embeddings', { baseUrl: url || undefined, model: model.trim(), apiKey: apiKey.trim() || undefined }));
                onClose();
              })
            }
          >
            Check and save
          </Button>
        </>
      }
    >
      <div className="stack">
        <SegmentedControl<Provider>
          aria-label="Provider"
          variant="tray"
          value={provider}
          onChange={(p) => {
            setProvider(p);
            if (p === 'local' && !isLocal(baseUrl)) setBaseUrl(OLLAMA);
            if (p === 'other' && isLocal(baseUrl)) setBaseUrl('');
          }}
          options={[
            { value: 'local', label: 'On this machine' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'other', label: 'Another provider' },
          ]}
        />
        {provider !== 'openai' && (
          <TextField
            label="Base URL"
            placeholder="https://api.example.com/v1"
            hint={provider === 'local' ? 'Ollama answers here by default. Nothing leaves this machine.' : 'Any OpenAI-compatible endpoint.'}
            value={baseUrl}
            onChange={(ev) => setBaseUrl(ev.target.value)}
          />
        )}
        {models?.length ? (
          <ModelList models={models.map((m) => ({ id: m, name: m }))} value={model} onChange={setModel} hint={provider === 'local' ? 'Models this endpoint has. Embedding models come first.' : undefined} />
        ) : (
          <TextField
            label="Model"
            placeholder={provider === 'local' ? 'bge-m3' : 'text-embedding-3-small'}
            hint={models === null ? 'Looking for the models of this endpoint…' : listing ? `Type the name. ${listing}` : 'Type the name of the model.'}
            value={model}
            onChange={(ev) => setModel(ev.target.value)}
          />
        )}
        {provider !== 'local' && (
          <TextField
            label="API key"
            type="password"
            optional={provider === 'other' || e.keySet}
            placeholder={e.keySet ? 'Saved. Leave empty to keep it' : undefined}
            hint="Saved in .env on this machine. It is not shown again."
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            autoComplete="off"
          />
        )}
        {changes && (
          <p className="muted">
            Vectors of two models cannot be mixed. After saving, search by meaning pauses until you make new vectors for the {num(state.index?.chunks ?? 0)} passages; keyword
            search keeps working.
          </p>
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}
