import { useEffect, useState } from 'react';
import { call, signIn, type Changed, type State, type UpstreamView } from '../api';
import { AskFirst, Choice, Page, Row, Section, useAction, useServer } from '../app';
import { CliStep } from '../cli-step';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { TextField } from '../ui/text-field';

type AppId = 'slack' | 'github' | 'railway';
type App = { id: AppId; name: string; gives: string; token: string; hint: string };
const APPS: App[] = [
  { id: 'slack', name: 'Slack', gives: 'Channels, threads, files and search. It only reads.', token: 'Bot token', hint: 'Starts with xoxb-.' },
  { id: 'github', name: 'GitHub', gives: 'Repositories, issues and pull requests. It only reads.', token: 'Personal access token', hint: 'A fine-grained token with read access to the repositories is enough.' },
  { id: 'railway', name: 'Railway', gives: 'Services, deployments and logs.', token: 'Token', hint: 'An account or a project token.' },
];

/**
 * Slack has no sign-in a local server can use (it wants a secret and a public https address). What it does have is
 * a link that opens "Create an app" with everything filled in: here, the six read-only permissions the tools use.
 */
const SLACK_MANIFEST = {
  display_information: { name: 'Knowledge MCP', description: 'Lets an AI assistant read the channels it is invited to.' },
  features: { bot_user: { display_name: 'Knowledge MCP', always_online: false } },
  oauth_config: { scopes: { bot: ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'files:read', 'users:read'] } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
};
const SLACK_NEW_APP = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}`;

/**
 * Apps that run an MCP server of their own. Each of these addresses answered an MCP request and said that a
 * client may register itself to sign in (looked at in November 2026); any other MCP server is added by address.
 */
const CATALOG: Array<{ name: string; label: string; url: string; note?: string }> = [
  { name: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'supabase', label: 'Supabase', url: 'https://mcp.supabase.com/mcp?read_only=true', note: 'Added in its read-only mode: queries run as a database user that cannot change anything.' },
  { name: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'atlassian', label: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/mcp' },
  { name: 'sentry', label: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'vercel', label: 'Vercel', url: 'https://mcp.vercel.com' },
  { name: 'stripe', label: 'Stripe', url: 'https://mcp.stripe.com' },
  { name: 'airtable', label: 'Airtable', url: 'https://mcp.airtable.com/mcp' },
  { name: 'figma', label: 'Figma', url: 'https://mcp.figma.com/mcp' },
  { name: 'canva', label: 'Canva', url: 'https://mcp.canva.com/mcp' },
  { name: 'monday', label: 'monday.com', url: 'https://mcp.monday.com/mcp' },
  { name: 'clickup', label: 'ClickUp', url: 'https://mcp.clickup.com/mcp' },
  { name: 'intercom', label: 'Intercom', url: 'https://mcp.intercom.com/mcp' },
  { name: 'posthog', label: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { name: 'neon', label: 'Neon', url: 'https://mcp.neon.tech/mcp' },
  { name: 'dropbox', label: 'Dropbox', url: 'https://mcp.dropbox.com/mcp' },
];
const OTHER = 'another';

export function Apps() {
  const { state } = useServer();
  const [open, setOpen] = useState<AppId | null>(null);
  const [adding, setAdding] = useState(false);
  const app = APPS.find((a) => a.id === open);
  return (
    <Page title="Apps" text="Other places the assistant can look.">
      <Section title="Built in" text="This server's own read-only tools. Sign in where the app allows it, or paste a token.">
        <div className="rows">
          {APPS.map((a) => <AppRow key={a.id} app={a} onConnect={() => setOpen(a.id)} />)}
        </div>
      </Section>
      <Section
        title="More apps"
        text="Apps with an MCP server of their own, such as Notion or Supabase. Their tools arrive under the app's name, behind your keys and permissions."
        action={<Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setAdding(true)}>Add an app</Button>}
      >
        <div className="rows">
          {state.upstreams.length === 0 && <Row title="None yet" help="Pick one from the list, or give the address of any MCP server. You sign in at the app; no token to copy." />}
          {state.upstreams.map((u) => <ServerRow key={u.name} server={u} />)}
        </div>
      </Section>
      {app && <Connect app={app} signedIn={app.id === 'railway' && state.services.railway.via === 'login'} onClose={() => setOpen(null)} />}
      {adding && <AddServer taken={state.upstreams.map((u) => u.name)} onClose={() => setAdding(false)} />}
    </Page>
  );
}

/** Ask the server to add an MCP server. It answers with the address to sign in at, or adds it at once. */
async function addServer(body: { name: string; url: string; token?: string }): Promise<Changed> {
  const r = await call<Changed | { signIn: string }>('POST', '/upstreams', body);
  if ('signIn' in r) {
    location.assign(r.signIn as string);
    return new Promise<never>(() => undefined); // the page is on its way out
  }
  return r;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function ServerRow({ server: u }: { server: UpstreamView }) {
  const { state, apply } = useServer();
  const act = useAction();
  const signedOut = u.via === 'login' && u.signedIn === false;
  const badge = !u.running
    ? { tone: 'neutral' as const, text: 'Saved' }
    : signedOut
      ? { tone: 'warning' as const, text: 'Sign in needed' }
      : u.connected
        ? { tone: 'success' as const, text: 'Connected' }
        : { tone: 'warning' as const, text: 'Not connected' };
  const tools = `${u.tools} tool${u.tools === 1 ? '' : 's'}, named ${u.prefix}…`;
  const help = !u.running
    ? `Starts with the server. ${hostOf(u.url)}`
    : u.connected
      ? `${tools}${u.hidden ? ` ${u.hidden} more that change things are off.` : u.expose === 'all' ? ' Tools that change things are on.' : ''} ${hostOf(u.url)}`
      : signedOut
        ? `The sign-in is gone. ${hostOf(u.url)}`
        : `${u.error ?? 'No answer yet.'} ${hostOf(u.url)}`;
  const set = (expose: 'read' | 'all') => act.run(() => apply(() => call<Changed>('PATCH', `/upstreams/${u.name}`, { expose })));
  return (
    <Row title={u.name} help={act.error ?? help}>
      <Badge size="md" tone={badge.tone}>{badge.text}</Badge>
      {u.via === 'login' && (signedOut || (u.running && !u.connected)) && (
        <Button size="sm" variant="secondary" loading={act.busy} disabled={!state.editable} onClick={() => void act.run(() => addServer({ name: u.name, url: u.url }).then((r) => apply(async () => r)))}>
          Sign in
        </Button>
      )}
      {u.expose === 'read' && u.hidden > 0 && state.editable && (
        <AskFirst
          label="Allow changes"
          title={`Let ${u.name} change things?`}
          text={`Its other ${u.hidden} tool${u.hidden === 1 ? '' : 's'} can create, change and delete there, as the account that signed in, for everyone who may use ${u.name} on this server.`}
          confirm="Allow"
          disabled={act.busy}
          onConfirm={() => set('all')}
        />
      )}
      {u.expose === 'all' && <Button size="sm" variant="ghost" disabled={act.busy || !state.editable} onClick={() => void set('read')}>Read only</Button>}
      <AskFirst
        label="Remove"
        title={`Remove ${u.name}?`}
        text={u.via === 'login' ? 'Its tools go away. The sign-in is deleted from this machine and withdrawn at the app where it allows that.' : 'Its tools go away, and a token that was pasted here is deleted from .env.'}
        confirm="Remove"
        disabled={act.busy || !state.editable}
        onConfirm={() => act.run(() => apply(() => call<Changed>('DELETE', `/upstreams/${u.name}`)))}
      />
    </Row>
  );
}

function AddServer({ taken, onClose }: { taken: string[]; onClose: () => void }) {
  const { apply } = useServer();
  const choices = CATALOG.filter((c) => !taken.includes(c.name));
  const [pick, setPick] = useState(choices[0]?.name ?? OTHER);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [withToken, setWithToken] = useState(false);
  const [token, setToken] = useState('');
  const add = useAction();
  const chosen = choices.find((c) => c.name === pick);
  const target = chosen ? { name: chosen.name, url: chosen.url } : { name: name.trim(), url: url.trim() };
  const ready = target.name.length > 0 && target.url.length > 8 && (!withToken || token.trim().length >= 10);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an app"
      description="You sign in at the app and choose there what it may see. Only its tools that read are turned on, and everyone who may use them on this server sees what your sign-in sees."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={add.busy}
            disabled={!ready}
            onClick={() =>
              void add.run(async () => {
                const r = await addServer({ ...target, ...(withToken ? { token: token.trim() } : {}) });
                await apply(async () => r);
                onClose();
              })
            }
          >
            Connect
          </Button>
        </>
      }
    >
      <div className="stack">
        <Select
          label="App"
          value={pick}
          onChange={(v) => setPick(v)}
          options={[...choices.map((c) => ({ value: c.name, label: c.label })), { value: OTHER, label: 'Another MCP server' }]}
          hint={chosen ? chosen.note ?? chosen.url : 'Any server that speaks MCP over HTTP.'}
        />
        {!chosen && (
          <>
            <TextField label="Name" placeholder="wiki" hint="Lowercase letters, digits and dashes. Its tools are named after it." value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
            <TextField label="Address" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
          </>
        )}
        {withToken ? (
          <TextField label="Token" type="password" hint="Checked by listing the tools, then saved in .env on this machine." value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        ) : (
          <p className="field-help">
            <button type="button" className="link" onClick={() => setWithToken(true)}>The app gave me a token instead</button>
          </p>
        )}
        {add.error && <p className="error" role="alert">{add.error}</p>}
      </div>
    </Dialog>
  );
}

function AppRow({ app, onConnect }: { app: App; onConnect: () => void }) {
  const { state, apply } = useServer();
  const off = useAction();
  const plugin = state.plugins.find((p: State['plugins'][number]) => p.id === app.id);
  const service = state.services[app.id];
  const signedIn = app.id === 'railway' && state.services.railway.via === 'login';
  const how = signedIn ? `Signed in${state.services.railway.who ? ` as ${state.services.railway.who}` : ''}. ${app.gives}` : app.gives;
  return (
    <Row title={app.name} help={off.error ?? how}>
      {service.set && <Badge size="md" tone={plugin?.enabled === false ? 'warning' : 'success'}>{plugin?.enabled === false ? 'Not ready' : 'Connected'}</Badge>}
      {service.set && (
        <AskFirst
          label="Disconnect"
          title={`Disconnect ${app.name}?`}
          text={signedIn ? `Its tools go away. The sign-in is deleted from this machine and withdrawn at ${app.name}.` : 'Its tools go away and the token is deleted from .env on this machine.'}
          confirm="Disconnect"
          disabled={off.busy}
          onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', `/services/${app.id}`)))}
        />
      )}
      <Button size="sm" variant="secondary" onClick={onConnect}>{service.set ? 'Change' : 'Connect'}</Button>
    </Row>
  );
}

function Connect({ app, signedIn, onClose }: { app: App; signedIn: boolean; onClose: () => void }) {
  const { apply } = useServer();
  const [token, setToken] = useState('');
  const save = useAction();
  const quick = useAction(); // the way that needs no token
  // Railway: also read logs. Off unless the person turns it on: it asks for more than looking.
  const [railwayLogs, setRailwayLogs] = useState(false);
  // GitHub: is the gh CLI signed in on this machine, and as whom?
  const [gh, setGh] = useState<{ installed: boolean; login: string | null } | null>(null);
  const [ghAsked, setGhAsked] = useState(0); // asked again after a step with gh from here ended
  // The person pressed the button that installs or signs in gh: what comes after it goes by itself, up to "connected".
  const [ghGoing, setGhGoing] = useState(false);
  const [ghInstalled, setGhInstalled] = useState(false); // an install from here ended well
  const useGh = () =>
    quick.run(async () => {
      await apply(() => call<Changed>('POST', '/services/github', { fromGh: true }));
      onClose();
    });
  const ghLogin = gh?.login ?? null;
  useEffect(() => {
    if (app.id === 'github' && ghGoing && ghLogin && !quick.busy && !quick.error) void useGh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghGoing, ghLogin]);
  useEffect(() => {
    if (app.id !== 'github') return;
    let live = true;
    call<{ installed: boolean; login: string | null }>('GET', '/logins/gh').then((r) => live && setGh(r), () => undefined);
    return () => {
      live = false;
    };
  }, [app.id, ghAsked]);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Connect ${app.name}`}
      description="A token is checked with the service, then saved in .env on this machine. It is not shown again."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={token.trim().length < 10 || quick.busy}
            onClick={() =>
              void save.run(async () => {
                await apply(() => call<Changed>('POST', `/services/${app.id}`, { token }));
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
        {app.id === 'railway' && (
          <>
            <Choice
              title={signedIn ? 'Sign in again with Railway' : 'Sign in with Railway'}
              help={`Railway opens in this tab. You pick the workspaces it may read, as a ${railwayLogs ? 'member' : 'viewer'}. Nothing to copy.`}
              error={quick.error}
            >
              <Button variant="secondary" loading={quick.busy} onClick={() => void quick.run(() => signIn('/logins/railway', { logs: railwayLogs }))}>Sign in</Button>
            </Choice>
            <Switch
              size="sm"
              label="Also read logs"
              description="Railway shows logs to members of a workspace, not to viewers. With this on the sign-in asks for member access, which could also change things. This server only reads."
              checked={railwayLogs}
              onChange={(e) => setRailwayLogs(e.target.checked)}
            />
            <div className="or">or paste a token</div>
          </>
        )}
        {app.id === 'github' && gh?.login && (
          <>
            <Choice
              title={`Use the gh login (${gh.login})`}
              help="The gh CLI on this machine is signed in. Its token can do what gh can; for a server other people use, a read-only token is safer."
              error={quick.error}
            >
              <Button variant="secondary" loading={quick.busy} onClick={() => void useGh()}>
                Use it
              </Button>
            </Choice>
            <div className="or">or paste a token</div>
          </>
        )}
        {app.id === 'github' && gh && !gh.login && (
          // gh is missing or signed out. The server installs it and runs its sign-in, and its login is then used:
          // one button, and a code typed at GitHub.
          <>
            <Choice
              stacked
              title="Connect with the gh CLI"
              help={
                !gh.installed
                  ? 'The gh CLI is not on this machine. This installs it, signs it in with a code you type at GitHub, and uses its login.'
                  : 'The gh CLI is on this machine and not signed in. This signs it in with a code you type at GitHub, and uses its login.'
              }
            >
              {!gh.installed ? (
                ghInstalled ? (
                  <p className="field-help">gh is installed, but this server does not find it yet. Start the server again, then come back here.</p>
                ) : (
                  <CliStep
                    tool="gh"
                    action="install"
                    label="Install gh and connect"
                    onStart={() => setGhGoing(true)}
                    onDone={() => {
                      setGhInstalled(true);
                      setGhAsked((n) => n + 1);
                    }}
                  />
                )
              ) : (
                <CliStep tool="gh" action="sign-in" label="Sign in and connect" autoStart={ghGoing} onStart={() => setGhGoing(true)} onDone={() => setGhAsked((n) => n + 1)} />
              )}
            </Choice>
            <div className="or">or paste a token</div>
          </>
        )}
        {app.id === 'slack' && (
          <ol className="steps">
            <li>
              <a href={SLACK_NEW_APP} target="_blank" rel="noreferrer">Create the Slack app</a>. Slack opens with the read-only permissions filled in. Pick your workspace and press Create.
            </li>
            <li>In the app, open Install App and install it to the workspace. Copy the Bot User OAuth Token.</li>
            <li>Paste it below. Then invite the bot to each channel it should read: <code>/invite @Knowledge MCP</code></li>
          </ol>
        )}
        <TextField label={app.token} type="password" hint={app.hint} error={save.error ?? undefined} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus={app.id !== 'railway'} />
      </div>
    </Dialog>
  );
}
