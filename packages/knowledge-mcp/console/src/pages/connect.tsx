import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { Page, Row, Section, useAction, useServer } from '../app';
import { CliStep } from '../cli-step';
import { TextField } from '../ui/text-field';
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
        <Tunnel http={data?.http ?? null} local={data?.url ?? null} />
        <div className="stack">
          <p className="muted">
            Each person needs a key. Sign-in with Google replaces keys for Claude on the web. To run the server somewhere else instead, the README
            has a Docker image and deploy notes.
          </p>
          <div><Button size="sm" variant="secondary" onClick={() => go('people')}>Create a key</Button></div>
        </div>
      </Section>
    </Page>
  );
}

interface TunnelView {
  installed: boolean;
  signedIn: boolean;
  /** The domain this server's Cloudflare sign-in is for, when Cloudflare said. */
  signedInFor: string | null;
  /** An address of one's own answered from outside. */
  verified: boolean;
  running: boolean;
  mode: 'quick' | 'named' | null;
  url: string | null;
  hostname: string | null;
  problem: string | null;
}
interface AddressCheck {
  hostname: string;
  apex: string;
  signedInFor: string | null;
  unknown: string | null;
  ready: boolean;
}

/**
 * A public address for this server through a Cloudflare Tunnel: the server stays here, Cloudflare gives it an
 * https address. A temporary one needs nothing. An address of one's own needs a domain in a Cloudflare account:
 * the address is checked first (is its domain on Cloudflare, is this server signed in for it), and it counts as
 * working only once it answers from outside.
 */
function Tunnel({ http, local }: { http: string | null; local: string | null }) {
  const [t, setT] = useState<TunnelView | null>(null);
  const [own, setOwn] = useState(false);
  const [hostname, setHostname] = useState('');
  const [check, setCheck] = useState<AddressCheck | null>(null);
  const act = useAction();
  const checking = useAction();
  const load = useCallback(() => call<TunnelView>('GET', '/tunnel').then((v) => (setT(v), setHostname((h) => h || v.hostname || '')), () => undefined), []);
  useEffect(() => void load(), [load]);
  if (!t) return null;
  const start = (body: object) => void act.run(async () => setT(await call<TunnelView>('POST', '/tunnel', body)));
  const look = (name = hostname) => void checking.run(async () => setCheck(await call<AddressCheck>('POST', '/tunnel/check', { hostname: name })));
  const afterSignIn = () => void load().then(() => check && look(check.hostname));
  // What a client is given: the entry above, with the public address in place of this machine's.
  const entry = t.url && http && local ? http.split(local).join(`${t.url}/mcp`) : null;
  const wrongDomain = !!check && !!check.signedInFor && check.signedInFor !== check.apex;
  return (
    <div className="rows">
      {t.running && t.url ? (
        <Row
          title={
            <>
              {`${t.url}/mcp`} {t.mode === 'named' && (t.verified ? <Badge tone="success">Answers</Badge> : <Badge tone="warning">Not answering yet</Badge>)}
            </>
          }
          help={
            t.problem && !t.verified && t.mode === 'named'
              ? t.problem
              : t.mode === 'quick'
                ? 'A temporary address from Cloudflare, for trying it out. It changes each time it is started, and Cloudflare gives no guarantee for it. The console stays on this computer.'
                : 'Your address, through a Cloudflare Tunnel. It answered from outside. The server and your documents stay on this computer, and so does the console.'
          }
        >
          {t.mode === 'named' && !t.verified && (
            <Button size="sm" variant="secondary" loading={act.busy} onClick={() => void act.run(async () => setT(await call<TunnelView>('POST', '/tunnel/recheck')))}>Check again</Button>
          )}
          <Button size="sm" variant="ghost" loading={act.busy} onClick={() => void act.run(async () => setT(await call<TunnelView>('DELETE', '/tunnel')))}>Stop</Button>
        </Row>
      ) : !t.installed ? (
        <Row title="A public address through Cloudflare" help="The server stays on this computer. cloudflared, Cloudflare's program, gives it an https address: nothing to open in a router, no certificate to make.">
          <CliStep tool="cloudflared" action="install" label="Install cloudflared" onDone={() => void load()} />
        </Row>
      ) : (
        <>
          <Row
            title="A temporary address"
            help={t.problem && t.mode !== 'named' ? t.problem : 'No account needed. For trying it out: the address is new each time, and Cloudflare gives no guarantee for it.'}
          >
            <Button size="sm" variant="secondary" loading={act.busy && !own} onClick={() => start({ mode: 'quick' })}>Start</Button>
          </Row>
          <Row
            title="Your own address"
            help={
              t.problem && t.mode === 'named'
                ? t.problem
                : t.signedIn
                  ? `A name on a domain in your Cloudflare account. This server is signed in to Cloudflare${t.signedInFor ? ` for ${t.signedInFor}` : ''}.`
                  : 'A name on a domain in your Cloudflare account, like mcp.example.com. It stays the same, and comes back when the server is started again.'
            }
          >
            {t.signedIn && (
              <Button size="sm" variant="ghost" onClick={() => void act.run(async () => { setT(await call<TunnelView>('DELETE', '/tunnel/sign-in')); setCheck(null); })}>Sign out</Button>
            )}
            {!own && <Button size="sm" variant="secondary" onClick={() => setOwn(true)}>Set up</Button>}
          </Row>
          {own && (
            <div className="row-form">
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  look();
                }}
              >
                <TextField
                  label="Address"
                  placeholder="mcp.example.com"
                  value={hostname}
                  onChange={(e) => {
                    setHostname(e.target.value);
                    setCheck(null);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" variant="secondary" loading={checking.busy} disabled={hostname.trim().length < 4}>Check</Button>
              </form>
              {checking.error ? (
                <p className="error" role="alert">{checking.error}</p>
              ) : (
                !check && <p className="field-help">Its domain must be in your Cloudflare account. It is checked before anything is made.</p>
              )}
              {check && !t.signedIn && (
                <>
                  <p className="field-help">
                    {check.apex} is on Cloudflare. Sign in to Cloudflare, and on its page pick <b>{check.apex}</b>. What cloudflared is given is kept with this server, apart from any cloudflared sign-in of yours.
                  </p>
                  <CliStep tool="cloudflared" action="sign-in" label="Sign in to Cloudflare" onDone={afterSignIn} />
                </>
              )}
              {check && t.signedIn && wrongDomain && (
                <>
                  <p className="error" role="alert">
                    This server is signed in for {check.signedInFor}, and {check.hostname} is under {check.apex}. Sign in again and pick {check.apex}.
                  </p>
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => void act.run(async () => setT(await call<TunnelView>('DELETE', '/tunnel/sign-in')))}>Sign in again</Button>
                  </div>
                </>
              )}
              {check && t.signedIn && !wrongDomain && (
                <div className="inline">
                  <p className="field-help">
                    {check.signedInFor
                      ? `Signed in for ${check.apex}. The tunnel and the DNS record of ${check.hostname} are made in that account; a record already there is not written over.`
                      : `Signed in to Cloudflare, but Cloudflare did not say for which domain (${check.unknown}). Start only if you picked ${check.apex} when signing in: a record made under another domain is reported, for you to remove.`}
                  </p>
                  <Button variant="secondary" loading={act.busy} onClick={() => start({ mode: 'named', hostname: check.hostname })}>Start</Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      {(entry ?? http) && <CodeBlock code={entry ?? http ?? ''} language="json" wrap />}
    </div>
  );
}

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
