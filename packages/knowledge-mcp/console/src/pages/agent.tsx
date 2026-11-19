/**
 * Agent: work the server does by itself, with a language model the person connects. Until one is connected the
 * server calls no model. The model is picked from the provider's own list.
 */
import { useEffect, useState } from 'react';
import { call, type Changed } from '../api';

/** The ChatGPT sign-in, as the server reports it (core/chatgpt.ts). */
interface ChatgptView {
  signedIn: boolean;
  email: string | null;
  planUsage: boolean;
  waiting: boolean;
  error: string | null;
}
import { AskFirst, Page, Row, Section, useAction, useServer } from '../app';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { TextField } from '../ui/text-field';

type Kind = 'anthropic' | 'openai' | 'chatgpt';
interface Provider {
  id: string;
  label: string;
  kind: Kind;
  /** openai kind: the API base. Empty for "another endpoint", where the person types it. */
  baseUrl?: string;
  needsKey: boolean;
  keyHint: string;
}
const PROVIDERS: Provider[] = [
  { id: 'chatgpt', label: 'ChatGPT account (Plus or Pro)', kind: 'chatgpt', needsKey: false, keyHint: '' },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    needsKey: true,
    keyHint: 'An API key from the Claude Console. A Claude Pro or Max plan cannot be used here: Anthropic does not let other apps use it.',
  },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyHint: 'An OpenRouter key. One key reaches the models of many providers.' },
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyHint: 'An OpenAI API key.' },
  { id: 'ollama', label: 'Ollama on this machine', kind: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false, keyHint: '' },
  { id: 'other', label: 'Another endpoint', kind: 'openai', needsKey: false, keyHint: 'Leave empty when the endpoint needs none.' },
];
/** Which of the choices the saved settings are. */
const providerOf = (kind: Kind | null, baseUrl: string | null): Provider =>
  PROVIDERS.find((p) => p.kind === kind && (kind !== 'openai' || p.baseUrl === baseUrl)) ?? PROVIDERS[kind === 'openai' ? PROVIDERS.length - 1 : 0];

export function Agent() {
  const { state, apply } = useServer();
  const llm = state.services.llm;
  const [open, setOpen] = useState(false);
  const saved = providerOf(llm.provider, llm.baseUrl);
  return (
    <Page title="Agent" text="Work the server does by itself, with a model you connect.">
      <Section title="Model" text="Used for the jobs on this page and for Chat. Search and the tools work without it.">
        <div className="rows">
          <Row
            title={llm.set ? llm.model : 'No model connected'}
            help={
              llm.set
                ? `${saved.id === 'other' ? llm.baseUrl : saved.label}. Text of your documents goes to it only while a job here runs or you chat.`
                : 'Your ChatGPT plan, Claude, OpenRouter, OpenAI, a model on this machine, or any endpoint that speaks the OpenAI API.'
            }
          >
            <Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setOpen(true)}>{llm.set ? 'Change' : 'Connect'}</Button>
            {llm.set && (
              <AskFirst
                label="Disconnect"
                title="Disconnect the model?"
                text="The key is removed from .env on this machine. Jobs that need a model stop working until one is connected again."
                confirm="Disconnect"
                disabled={!state.editable}
                onConfirm={() => apply(() => call<Changed>('DELETE', '/services/llm'))}
              />
            )}
          </Row>
        </div>
      </Section>
      <Wiki />
      {open && <ConnectModel onClose={() => setOpen(false)} />}
    </Page>
  );
}

interface WikiRun {
  running: boolean;
  done: number;
  total: number;
  phase: 'reading' | 'writing';
  current: string | null;
  written: number;
  failed: Array<{ document: string; why: string }>;
  usage: { input: number; output: number; calls: number };
  stopped: string | null;
  finishedAt: string | null;
}
interface WikiStatus {
  exists: boolean;
  path: string;
  documents: number;
  topics: number;
  waiting: number;
  gone: number;
  run: WikiRun | null;
  model: boolean;
}
/** How many documents one press reads. Reading costs: a person sees what it came to before reading on. */
const BATCH = 25;
const n = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

/** The wiki the model writes from the documents: make it, read documents into it, and see how far a run is. */
function Wiki() {
  const { state, apply } = useServer();
  const [wiki, setWiki] = useState<WikiStatus | null>(null);
  const act = useAction();
  const load = () => call<WikiStatus>('GET', '/wiki').then(setWiki, () => undefined);
  // Asked again when the settings change (a model was connected, the folder was made).
  useEffect(() => {
    void load();
  }, [state.services.llm.set, state.folders.length]);
  const running = !!wiki?.run?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [running]);

  const run = wiki?.run ?? null;
  const next = Math.min(wiki?.waiting ?? 0, BATCH);
  const last = run && !run.running ? run : null;
  return (
    <Section title="Wiki" text="Pages the model writes from your documents: one per document, and one per topic that gathers what all of them say.">
      <div className="rows">
        {!wiki ? null : !wiki.exists ? (
          <Row
            title="No wiki yet"
            help="A folder of Markdown pages with links between them, beside your settings. It is searched like your other folders, and opens in Obsidian as it is. Your documents are not changed."
          >
            <Button size="sm" variant="secondary" loading={act.busy} disabled={!state.editable} onClick={() => void act.run(async () => { await apply(() => call<Changed>('POST', '/wiki')); await load(); })}>
              Create the wiki
            </Button>
          </Row>
        ) : (
          <Row
            title={wiki.path}
            help={
              running && run ? (
                run.phase === 'writing' ? (
                  <>All {n(run.total, 'document')} read. Writing the topic pages{run.current ? `: ${run.current}` : ''}</>
                ) : (
                  <>
                    Reading {Math.min(run.done + 1, run.total).toLocaleString()} of {run.total.toLocaleString()}
                    {run.current ? `: ${run.current}` : ''}
                  </>
                )
              ) : (
                <>
                  {n(wiki.documents, 'document')} read, {n(wiki.topics, 'topic')}.{' '}
                  {wiki.waiting > 0 ? `${n(wiki.waiting, 'document')} new or changed since.` : wiki.documents > 0 ? 'Nothing new to read.' : 'Nothing is read yet.'}
                  {!wiki.model && <span className="row-note">Connect a model above to read documents into it.</span>}
                  {last && (
                    <span className="row-note">
                      Last run: {n(last.done - last.failed.filter((f) => !f.document.startsWith('topic: ')).length, 'document')} read with {n(last.usage.calls, 'question')} to the model (
                      {last.usage.input.toLocaleString()} tokens in, {last.usage.output.toLocaleString()} out).
                      {last.stopped ? ` ${last.stopped}` : ''}
                    </span>
                  )}
                  {last && last.failed.length > 0 && (
                    <span className="row-note">
                      Not read: {last.failed.slice(0, 3).map((f) => `${f.document} (${f.why})`).join('; ')}
                      {last.failed.length > 3 ? ` and ${last.failed.length - 3} more` : ''}
                    </span>
                  )}
                </>
              )
            }
          >
            {running ? (
              <Button size="sm" variant="ghost" onClick={() => void call('POST', '/wiki/stop').then(load, load)}>Stop</Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={act.busy}
                disabled={!wiki.model || next === 0}
                onClick={() => void act.run(async () => { await call('POST', '/wiki/run', { limit: BATCH }); await load(); })}
              >
                {next > 0 ? `Read ${n(next, 'document')}` : 'Read documents'}
              </Button>
            )}
          </Row>
        )}
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </Section>
  );
}

function ConnectModel({ onClose }: { onClose: () => void }) {
  const { state, apply } = useServer();
  const llm = state.services.llm;
  const [provider, setProvider] = useState<Provider>(providerOf(llm.provider, llm.baseUrl));
  const [address, setAddress] = useState(llm.provider === 'openai' && providerOf(llm.provider, llm.baseUrl).id === 'other' ? llm.baseUrl ?? '' : '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [filter, setFilter] = useState('');
  const [model, setModel] = useState('');
  const find = useAction();
  const save = useAction();
  const signIn = useAction();
  const [gpt, setGpt] = useState<ChatgptView | null>(null);
  const [waitingGpt, setWaitingGpt] = useState(false);
  const readGpt = () => call<ChatgptView>('GET', '/llm/chatgpt').then(setGpt, () => undefined);
  useEffect(() => {
    if (provider.kind === 'chatgpt') void readGpt();
  }, [provider.kind]);
  // While the person signs in on OpenAI's page (another tab), ask how it went every second or so.
  useEffect(() => {
    if (!waitingGpt) return;
    const timer = setInterval(() => void call<ChatgptView>('GET', '/llm/chatgpt').then((v) => {
      setGpt(v);
      if (v.signedIn || v.error || !v.waiting) setWaitingGpt(false);
    }, () => undefined), 1200);
    return () => clearInterval(timer);
  }, [waitingGpt]);
  const continueWithChatgpt = () =>
    void signIn.run(async () => {
      // Opened before the request, while the click still counts as the person's: a tab opened later is blocked.
      const tab = window.open('about:blank', '_blank');
      const { url } = await call<{ url: string }>('POST', '/llm/chatgpt/sign-in');
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      setWaitingGpt(true);
    });

  const baseUrl = provider.kind === 'openai' ? (provider.baseUrl ?? address.trim()) : '';
  // A key saved for this very provider can be used again without typing it.
  const keySaved = llm.keySet && llm.provider === provider.kind && (provider.kind === 'anthropic' || llm.baseUrl === baseUrl);
  const body = provider.kind === 'chatgpt' ? { provider: 'chatgpt' } : { provider: provider.kind, baseUrl: baseUrl || undefined, apiKey: apiKey.trim() || undefined };
  const ready =
    provider.kind === 'chatgpt'
      ? !!gpt?.signedIn && gpt.planUsage
      : (provider.kind === 'anthropic' || baseUrl.length > 8) && (!provider.needsKey || apiKey.trim().length >= 8 || keySaved);

  const choose = (id: string) => {
    setProvider(PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]);
    setModels(null);
    setModel('');
    setFilter('');
    find.clear();
    save.clear();
  };
  const findModels = () =>
    void find.run(async () => {
      const r = await call<{ models: Array<{ id: string; name: string }> }>('POST', '/llm/models', body);
      setModels(r.models);
      // The model already in use stays chosen. Otherwise nothing is chosen for the person.
      setModel(r.models.some((m) => m.id === llm.model) ? llm.model ?? '' : '');
    });
  const gptReady = provider.kind === 'chatgpt' && !!gpt?.signedIn && gpt.planUsage;
  useEffect(() => {
    if (gptReady && models === null) findModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gptReady]);
  const shown = (models ?? []).filter((m) => !filter.trim() || `${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Connect a model"
      description={
        provider.kind === 'chatgpt'
          ? 'The sign-in is kept on this machine, readable only by you. Text of your documents goes to OpenAI only while a job on the Agent page runs, or while you chat.'
          : 'The key is saved in .env on this machine. Text of your documents goes to this provider only while a job on the Agent page runs, or while you chat.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!ready || !model}
            onClick={() =>
              void save.run(async () => {
                await apply(() => call<Changed>('POST', '/services/llm', { ...body, model }));
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
        <Select label="Provider" value={provider.id} onChange={choose} options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))} />
        {provider.id === 'other' && (
          <TextField label="API address" placeholder="https://llm.example.com/v1" hint="The base of an API that speaks OpenAI's chat completions. It usually ends in /v1." value={address} onChange={(e) => { setAddress(e.target.value); setModels(null); setModel(''); }} autoComplete="off" spellCheck={false} />
        )}
        {provider.kind === 'chatgpt' && (
          <div className="stack">
            {gpt?.signedIn ? (
              <p className="field-help">
                Signed in{gpt.email ? ` as ${gpt.email}` : ''}.{' '}
                {gpt.planUsage ? (
                  <>
                    Answers use the usage included in your ChatGPT plan. You can see and limit it in{' '}
                    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">ChatGPT settings, Usage</a>.
                  </>
                ) : (
                  'Using your plan was not allowed. Continue with ChatGPT again and allow it.'
                )}{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    void signIn.run(async () => {
                      const after = await apply(() => call<Changed & ChatgptView>('DELETE', '/llm/chatgpt'));
                      setModels(null);
                      setModel('');
                      setGpt(after);
                    })
                  }
                >
                  Sign out
                </button>
              </p>
            ) : (
              <p className="field-help">
                Uses the usage included in your ChatGPT Plus or Pro plan, with no API key. OpenAI opens in a new tab: sign in there and allow Knowledge MCP.
              </p>
            )}
            {(!gpt?.signedIn || !gpt.planUsage) && (
              <div>
                <Button loading={signIn.busy || waitingGpt} onClick={continueWithChatgpt}>Continue with ChatGPT</Button>
              </div>
            )}
            {waitingGpt && <p className="field-help">Waiting for the sign-in in the other tab…</p>}
            {(signIn.error || gpt?.error) && <p className="error" role="alert">{signIn.error ?? gpt?.error}</p>}
          </div>
        )}
        {provider.id !== 'ollama' && provider.kind !== 'chatgpt' && (
          <TextField
            label="API key"
            type="password"
            hint={keySaved ? 'A key is saved for this provider. Leave this empty to keep it.' : provider.keyHint}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        )}
        {models === null ? (
          provider.kind === 'chatgpt' && !gptReady ? null : <div className="stack">
            <div><Button variant="secondary" loading={find.busy} disabled={!ready} onClick={findModels}>Find its models</Button></div>
            {find.error && <p className="error" role="alert">{find.error}</p>}
          </div>
        ) : models.length === 0 ? (
          <p className="field-help">This provider lists no models for the key.</p>
        ) : (
          <>
            {models.length > 25 && <TextField label="Find a model" placeholder="claude, gpt, llama…" value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />}
            <Select
              label="Model"
              value={model}
              onChange={setModel}
              options={shown.slice(0, 200).map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` }))}
              hint={shown.length > 200 ? `${shown.length.toLocaleString()} match. Type more to narrow the list.` : `${models.length.toLocaleString()} models from the provider's own list.`}
            />
          </>
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}
