import { useState } from 'react';
import { call, type Changed } from '../api';
import { AskFirst, Page, Row, Section, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { SegmentedControl } from '../ui/segmented-control';
import { TextArea } from '../ui/text-area';
import { TextField } from '../ui/text-field';

export function Documents() {
  const { state } = useServer();
  const i = state.index;
  return (
    <Page title="Documents" text="What the assistant can search and read.">
      {i?.problem && <div className="banner" data-tone="bad">{i.problem}</div>}
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
  const [key, setKey] = useState('');
  const [owner, setOwner] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const connect = useAction();
  const trust = useAction();
  const off = useAction();
  return (
    <Section title="Google Drive" text="Folders and documents shared with a service account.">
      <div className="rows">
        <Row title={drive.set ? 'Connected' : 'Not connected'} help={off.error ?? found ?? (drive.set ? 'Share a folder or a document with the service account to make it searchable.' : 'Needs a service account key from Google Cloud.')}>
          {drive.set && (
            <AskFirst
              label="Disconnect"
              title="Disconnect Google Drive?"
              text="The server stops reading Drive, and a key that was pasted here is deleted from this machine."
              confirm="Disconnect"
              disabled={off.busy}
              onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', '/services/drive')))}
            />
          )}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{drive.set ? 'Replace key' : 'Connect'}</Button>
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
                  : 'Nobody yet, so documents shared outside your folders stay hidden. Anyone can share a document with a service account; only trusted owners are shown.'}
              </p>
            )}
          </form>
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Connect Google Drive"
        description="Paste the key file of a service account. It is checked with Google, then saved on this machine."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              loading={connect.busy}
              disabled={key.trim().length < 50}
              onClick={() =>
                void connect.run(async () => {
                  const r = await apply(() => call<Changed & { email?: string }>('POST', '/services/drive', { key }));
                  setFound(r.email ? `Connected as ${r.email}. Share a folder or a document with this address.` : null);
                  setKey('');
                  setOpen(false);
                })
              }
            >
              Check and save
            </Button>
          </>
        }
      >
        <TextArea
          label="Service account key (JSON)"
          hint="No key yet? In a terminal: npm run setup -- drive --gcloud. It creates the account and the key for you."
          error={connect.error ?? undefined}
          minRows={6}
          maxRows={10}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          spellCheck={false}
        />
      </Dialog>
    </Section>
  );
}

function Meaning() {
  const { state, apply } = useServer();
  const e = state.services.embeddings;
  const i = state.index;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'openai' | 'other'>('other');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434/v1');
  const [model, setModel] = useState('');
  const save = useAction();
  const off = useAction();
  const waiting = i && e.set ? i.chunks - i.withVectors : 0;
  return (
    <Section title="Search by meaning" text="Optional. Search already works by keywords.">
      <div className="rows">
        <Row
          title={e.set ? e.model ?? 'On' : 'Keywords only'}
          help={
            e.set
              ? waiting > 0
                ? `${waiting.toLocaleString()} passages are still being prepared. Search works meanwhile.`
                : 'Also finds documents that use other words than the question.'
              : 'An embedding model also finds documents that use other words than the question. With one, passage text is sent to that model.'
          }
        >
          {e.set && <Badge size="md" tone="success">On</Badge>}
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
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{e.set ? 'Change' : 'Set up'}</Button>
        </Row>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Search by meaning"
        description="The model is asked once to make sure it answers, then saved."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              loading={save.busy}
              disabled={kind === 'openai' ? apiKey.trim().length < 10 : !baseUrl.trim() || !model.trim()}
              onClick={() =>
                void save.run(async () => {
                  await apply(() => call<Changed>('POST', '/services/embeddings', kind === 'openai' ? { apiKey } : { baseUrl, model, apiKey: apiKey || undefined }));
                  setApiKey('');
                  setOpen(false);
                })
              }
            >
              Check and save
            </Button>
          </>
        }
      >
        <div className="stack">
          <SegmentedControl<'openai' | 'other'>
            aria-label="Provider"
            variant="tray"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'other', label: 'A local model or another provider' },
              { value: 'openai', label: 'OpenAI' },
            ]}
          />
          {kind === 'other' && (
            <>
              <TextField label="Base URL" hint="Any OpenAI-compatible endpoint. Ollama: http://localhost:11434/v1" value={baseUrl} onChange={(ev) => setBaseUrl(ev.target.value)} />
              <TextField label="Model" placeholder="bge-m3" value={model} onChange={(ev) => setModel(ev.target.value)} />
            </>
          )}
          <TextField
            label="API key"
            type="password"
            optional={kind === 'other'}
            hint="Saved in .env on this machine. It is not shown again."
            error={save.error ?? undefined}
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            autoComplete="off"
          />
        </div>
      </Dialog>
    </Section>
  );
}
