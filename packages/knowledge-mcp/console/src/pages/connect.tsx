import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { Page, Row, Section, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Spinner } from '../ui/spinner';

interface Client {
  id: string;
  name: string;
  installed: boolean;
  added: boolean | null;
  how: 'command' | 'file' | 'link';
  does: string;
  link?: string;
  after: string;
  manual: { text: string; language: string; file?: string };
}
interface Clients {
  name: string;
  url: string;
  clients: Client[];
  http: string;
}

export function Connect() {
  const { go } = useServer();
  const [data, setData] = useState<Clients | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(
    () =>
      call<Clients>('GET', '/clients')
        .then(setData)
        .catch((e) => setFailed(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => void load(), [load]);

  return (
    <Page title="Connect a client" text="On this machine a client starts the server itself, so no key is needed.">
      <Section title="This machine">
        <div className="rows">
          {failed && <Row title="The clients could not be listed" help={failed} />}
          {!data && !failed && <Row title={<span className="actions"><Spinner /> Looking for clients</span>} />}
          {data?.clients.map((c) => <ClientRow key={c.id} client={c} onChanged={load} />)}
        </div>
      </Section>
      <Section title="Other people, Claude on the web, ChatGPT" text="They reach the server over the internet, with a key each.">
        <div className="stack">
          <p className="muted">
            Put the server behind HTTPS (the README has a Docker image and deploy notes), then give each person a key. Sign-in with Google replaces
            keys for Claude on the web.
          </p>
          {data && <CodeBlock code={data.http} language="json" wrap />}
          <div><Button size="sm" variant="secondary" onClick={() => go('people')}>Create a key</Button></div>
        </div>
      </Section>
    </Page>
  );
}

/** One client: whether this server is in it, one button that puts it there, and the same thing by hand on request. */
function ClientRow({ client: c, onChanged }: { client: Client; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const add = useAction();
  const run = () =>
    void add.run(async () => {
      setDone((await call<{ message: string }>('POST', `/clients/${c.id}/add`)).message);
      await onChanged();
    });

  const status = add.error ?? done ?? (!c.installed ? 'Not found on this machine. The entry is there for when it is.' : c.added ? `Connected. ${c.after}` : c.does);
  return (
    <>
      <Row title={c.name} help={<span className={add.error ? 'error' : undefined}>{status}</span>}>
        {c.added && <Badge size="md" tone="success">Connected</Badge>}
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide the entry' : 'Show the entry'}</button>
        {c.how === 'link' ? (
          // Cursor adds a server through its own link, and asks the person there.
          <Button size="sm" variant="secondary" disabled={!c.installed} onClick={() => c.link && (window.location.href = c.link)}>Open in Cursor</Button>
        ) : (
          <Button size="sm" variant="secondary" loading={add.busy} disabled={!c.installed} onClick={run}>{c.added ? 'Add again' : 'Add'}</Button>
        )}
      </Row>
      {open && (
        <div className="row-form">
          <CodeBlock code={c.manual.text} language={c.manual.language} filename={c.manual.file} wrap />
        </div>
      )}
    </>
  );
}
