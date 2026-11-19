import { useEffect, useState } from 'react';
import { call, signIn, type Changed } from '../api';
import { AskFirst, Page, Row, Section, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AlertDialog, Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { SegmentedControl } from '../ui/segmented-control';
import { TextArea } from '../ui/text-area';
import { TextField } from '../ui/text-field';

export function Documents() {
  return (
    <Page title="Documents" text="What the assistant can search and read.">
      <Folders />
      <Drive />
      <Meaning />
    </Page>
  );
}

function Folders() {
  const { state, apply } = useServer();
  const add = useAction();
  const remove = useAction();
  const [path, setPath] = useState('');
  return (
    <Section title="Folders on this machine" text="Markdown, text, PDF, Word, PowerPoint and Excel files. No account and no key.">
      <div className="rows">
        {state.folders.map((f) => (
          <Row key={f.path} title={f.path} help={f.documents === null ? 'This folder is not there any more.' : `${f.documents.toLocaleString()} documents`}>
            <Button size="sm" variant="ghost" disabled={remove.busy || !state.editable} onClick={() => void remove.run(() => apply(() => call<Changed>('DELETE', '/folders', { path: f.path })))}>
              Remove
            </Button>
          </Row>
        ))}
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add.run(async () => {
              await apply(() => call<Changed>('POST', '/folders', { path }));
              setPath('');
            });
          }}
        >
          <div className="inline">
            <TextField
              label="Add a folder"
              placeholder="/Users/you/Documents/handbook"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={!state.editable}
            />
            <Button type="submit" variant="secondary" loading={add.busy} disabled={!path.trim() || !state.editable}>Add</Button>
          </div>
          {add.error || remove.error ? (
            <p className="error" role="alert">{add.error ?? remove.error}</p>
          ) : (
            <p className="field-help">Everything under it becomes searchable by everyone who may use this server.</p>
          )}
        </form>
      </div>
    </Section>
  );
}

function Drive() {
  const { state, apply } = useServer();
  const drive = state.services.drive;
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const trust = useAction();
  const off = useAction();
  const signedIn = drive.via === 'login';
  const status = signedIn
    ? `Signed in as ${drive.account ?? 'a Google account'}. Reads ${drive.reads.join(', ') || 'no folder yet'}.`
    : drive.set
      ? 'Share a folder or a document with the service account to make it searchable.'
      : 'Sign in with Google, or share documents with a service account.';
  return (
    <Section title="Google Drive" text="Your own Drive through a sign-in, or what is shared with a service account.">
      <div className="rows">
        <Row title={drive.set ? 'Connected' : 'Not connected'} help={off.error ?? found ?? status}>
          {drive.set && (
            <AskFirst
              label="Disconnect"
              title="Disconnect Google Drive?"
              text={signedIn ? 'The server stops reading Drive. The sign-in is deleted from this machine and withdrawn at Google.' : 'The server stops reading Drive, and a key that was pasted here is deleted from this machine.'}
              confirm="Disconnect"
              disabled={off.busy}
              onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', '/services/drive')))}
            />
          )}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{drive.set ? 'Change' : 'Connect'}</Button>
        </Row>
        {drive.set && (
          <form
            className="row-form"
            onSubmit={(e) => {
              e.preventDefault();
              void trust.run(async () => {
                await apply(() => call<Changed>('POST', '/drive/trust', { entries: [owner] }));
                setOwner('');
              });
            }}
          >
            <div className="inline">
              <TextField
                label="Whose shared documents are shown"
                placeholder="acme.com or ann@acme.com"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                disabled={!state.editable}
              />
              <Button type="submit" variant="secondary" loading={trust.busy} disabled={!owner.trim() || !state.editable}>Trust</Button>
            </div>
            {trust.error ? (
              <p className="error" role="alert">{trust.error}</p>
            ) : (
              <p className="field-help">
                {drive.trusted.length
                  ? `Trusted now: ${drive.trusted.join(', ')}`
                  : signedIn
                    ? 'Nobody yet, so documents other people shared with you stay hidden. Anyone can share a document with you; only trusted owners are shown.'
                    : 'Nobody yet, so documents shared outside your folders stay hidden. Anyone can share a document with a service account; only trusted owners are shown.'}
              </p>
            )}
          </form>
        )}
      </div>
      {open && <ConnectDrive onClose={() => setOpen(false)} onFound={setFound} />}
    </Section>
  );
}

type Way = 'google' | 'gcloud' | 'key';
interface Gcloud {
  installed: boolean;
  account: string | null;
  project: string | null;
  projects: Array<{ id: string; name: string }>;
  problem: string | null;
}
const WAY_TEXT: Record<Way, string> = {
  google: 'Sign in once. The server then reads your Drive as you. It only reads.',
  gcloud: 'gcloud makes a service account. You then share folders with it, like with a colleague.',
  key: 'Paste the key file of a service account. It is checked with Google, then saved on this machine.',
};

function ConnectDrive({ onClose, onFound }: { onClose: () => void; onFound: (text: string | null) => void }) {
  const { apply } = useServer();
  const [way, setWay] = useState<Way>('google');
  const go = useAction();
  // Sign in with Google
  const [saved, setSaved] = useState<{ clientSaved: boolean; account: string | null } | null>(null);
  const [otherClient, setOtherClient] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState<'all' | 'folders'>('all');
  const [folders, setFolders] = useState('');
  // A service account made by gcloud
  const [gcloud, setGcloud] = useState<Gcloud | null>(null);
  const [project, setProject] = useState('');
  // A pasted key
  const [key, setKey] = useState('');

  useEffect(() => {
    call<{ clientSaved: boolean; account: string | null }>('GET', '/logins/google').then(setSaved, () => undefined);
  }, []);
  const lookForGcloud = () => {
    setGcloud(null);
    call<Gcloud>('GET', '/logins/gcloud').then(
      (g) => {
        setGcloud(g);
        setProject((p) => p || g.project || g.projects[0]?.id || '');
      },
      (e) => setGcloud({ installed: false, account: null, project: null, projects: [], problem: e instanceof Error ? e.message : String(e) }),
    );
  };
  useEffect(() => {
    if (way === 'gcloud' && !gcloud) lookForGcloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [way]);

  const useSaved = !!saved?.clientSaved && !otherClient;
  const ready =
    way === 'google'
      ? (useSaved || (clientId.trim().length > 20 && (clientSecret.trim().length >= 10 || clientId.trim().startsWith('{')))) && (scope === 'all' || folders.trim().length >= 10)
      : way === 'gcloud'
        ? !!gcloud?.account && project.trim().length >= 6
        : key.trim().length >= 50;
  const run = () =>
    void go.run(async () => {
      if (way === 'google') {
        await signIn('/logins/google', { ...(useSaved ? {} : { clientId, clientSecret }), folders: scope === 'folders' ? folders.split('\n') : null });
        return;
      }
      const r = await apply(() => call<Changed & { email?: string }>('POST', '/services/drive', way === 'gcloud' ? { gcloud: { project: project.trim() } } : { key }));
      onFound(r.email ? `Connected as ${r.email}. Share a folder or a document with this address.` : null);
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Connect Google Drive"
      description={WAY_TEXT[way]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={go.busy} disabled={!ready} onClick={run}>
            {way === 'google' ? 'Sign in with Google' : way === 'gcloud' ? 'Create the account' : 'Check and save'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <SegmentedControl<Way>
          aria-label="How to connect"
          variant="tray"
          value={way}
          onChange={setWay}
          options={[
            { value: 'google', label: 'Sign in with Google' },
            { value: 'gcloud', label: 'Account with gcloud' },
            { value: 'key', label: 'Paste a key' },
          ]}
        />
        {way === 'google' && (
          <>
            {useSaved ? (
              <p className="field-help">
                Uses the OAuth client saved here{saved?.account ? ` (last signed in as ${saved.account})` : ''}.{' '}
                <button type="button" className="link" onClick={() => setOtherClient(true)}>Use another client</button>
              </p>
            ) : (
              <>
                <ol className="steps">
                  <li>
                    Google lets an app read Drive only through an OAuth client of your own Google Cloud project. In a project,{' '}
                    <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">switch on the Google Drive API</a>.
                  </li>
                  <li>
                    On <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Credentials</a>, create an OAuth client ID of the type Desktop app. Google asks for a consent screen
                    first: Internal for a company account. With a personal account choose External and then Publish app, or the sign-in ends every 7 days.
                  </li>
                  <li>Copy the client ID and the client secret here. This is done once.</li>
                </ol>
                <TextField label="Client ID" placeholder="1234-abc.apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
                <TextField label="Client secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
              </>
            )}
            <SegmentedControl<'all' | 'folders'>
              aria-label="What to read"
              variant="tray"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All of My Drive' },
                { value: 'folders', label: 'Chosen folders' },
              ]}
            />
            {scope === 'folders' ? (
              <TextArea
                label="Folders"
                hint="Open each folder in Drive and paste its address, one per line."
                minRows={2}
                maxRows={5}
                value={folders}
                onChange={(e) => setFolders(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <p className="field-help">Everything in your My Drive becomes searchable by everyone who may use this server. What other people shared with you stays hidden until you trust its owner.</p>
            )}
          </>
        )}
        {way === 'gcloud' &&
          (!gcloud ? (
            <Spinner label="Looking for gcloud" />
          ) : !gcloud.installed ? (
            <p className="field-help">{gcloud.problem ?? 'The gcloud CLI is not on this machine. Install the Google Cloud SDK, or connect another way.'}</p>
          ) : !gcloud.account ? (
            <p className="field-help">
              gcloud is not signed in. In a terminal: <code>gcloud auth login</code>.{' '}
              <button type="button" className="link" onClick={lookForGcloud}>Look again</button>
            </p>
          ) : (
            <>
              {gcloud.projects.length ? (
                <Select
                  label="Project"
                  value={project}
                  onChange={(v) => setProject(v)}
                  options={gcloud.projects.map((p) => ({ value: p.id, label: p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id }))}
                  hint={`gcloud is signed in as ${gcloud.account}.`}
                />
              ) : (
                <TextField label="Project ID" hint={gcloud.problem ?? `gcloud is signed in as ${gcloud.account}.`} value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" spellCheck={false} />
              )}
              <p className="field-help">
                Switches on the Drive API there, creates the service account knowledge-mcp-drive and saves its key on this machine. The account gets no role in the project: it reads only what is shared
                with it. It takes up to a minute.
              </p>
            </>
          ))}
        {way === 'key' && (
          <TextArea label="Service account key (JSON)" minRows={6} maxRows={10} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
        )}
        {go.error && <p className="error" role="alert">{go.error}</p>}
      </div>
    </Dialog>
  );
}

type Provider = 'local' | 'openai' | 'other';
const OLLAMA = 'http://localhost:11434/v1';
const isLocal = (url: string | null) => !!url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);

/**
 * Search by meaning: which embedding model, and where its vectors stand.
 * Changing the model is two steps on purpose. Saving it costs nothing; making new vectors for every passage sends
 * all the passage text to the model (and is paid for, with a paid one), so that is a button of its own.
 */
function Meaning() {
  const { state, apply, refresh } = useServer();
  const e = state.services.embeddings;
  const i = state.index;
  const [open, setOpen] = useState(false);
  const off = useAction();
  const remake = useAction();

  const job = i?.job ?? null;
  const stale = !!(e.set && i?.problem); // the vectors in the index were made by another model
  const waiting = i && e.set && !stale ? i.chunks - i.withVectors : 0;
  const working = !!job?.running || waiting > 0;
  // While vectors are being made the numbers move: read them again every few seconds, on this page only.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const count = (n: number) => n.toLocaleString();
  const help = !e.set
    ? 'An embedding model also finds documents that use other words than the question. With one, passage text is sent to that model.'
    : job?.running
      ? `Making new vectors: ${count(i?.withVectors ?? 0)} of ${count(i?.chunks ?? 0)} passages. Search works by keywords meanwhile.`
      : job?.error
        ? job.error
        : stale
          ? `Paused. The index still holds vectors made by ${i?.vectorsFrom ?? 'another model'}, and the two cannot be mixed. Search answers by keywords until new vectors are made.`
          : waiting > 0
            ? `Preparing: ${count((i?.chunks ?? 0) - waiting)} of ${count(i?.chunks ?? 0)} passages. Search works meanwhile.`
            : 'Also finds documents that use other words than the question.';

  return (
    <Section title="Search by meaning" text="Optional. Search already works by keywords.">
      <div className="rows">
        <Row title={e.set ? e.model ?? 'On' : 'Keywords only'} help={<span className={job?.error && !job.running ? 'error' : undefined}>{off.error ?? remake.error ?? help}</span>}>
          {working && <Spinner />}
          {e.set && !stale && !working && <Badge size="md" tone="success">On</Badge>}
          {stale && !job?.running && (
            <AlertDialog
              trigger={<Button size="sm">Make new vectors</Button>}
              title={`Make new vectors for ${count(i?.chunks ?? 0)} passages?`}
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
          <Select label="Model" value={model} onChange={(v) => setModel(v)} options={models.map((m) => ({ value: m, label: m }))} hint={provider === 'local' ? 'Models this endpoint has. Embedding models come first.' : undefined} />
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
            Vectors of two models cannot be mixed. After saving, search by meaning pauses until you make new vectors for the {state.index?.chunks.toLocaleString()} passages; keyword
            search keeps working.
          </p>
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}
