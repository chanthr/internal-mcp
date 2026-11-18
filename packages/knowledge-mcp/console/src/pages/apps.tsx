import { useEffect, useState } from 'react';
import { call, signIn, type Changed, type State } from '../api';
import { AskFirst, Choice, Page, Row, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
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

export function Apps() {
  const { state } = useServer();
  const [open, setOpen] = useState<AppId | null>(null);
  const app = APPS.find((a) => a.id === open);
  return (
    <Page title="Apps" text="Other places the assistant can look. Sign in where the app allows it, or paste a token.">
      <div className="rows">
        {APPS.map((a) => <AppRow key={a.id} app={a} onConnect={() => setOpen(a.id)} />)}
      </div>
      {app && <Connect app={app} signedIn={app.id === 'railway' && state.services.railway.via === 'login'} onClose={() => setOpen(null)} />}
    </Page>
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
  // GitHub: is the gh CLI signed in on this machine, and as whom?
  const [gh, setGh] = useState<{ installed: boolean; login: string | null } | null>(null);
  useEffect(() => {
    if (app.id !== 'github') return;
    let live = true;
    call<{ installed: boolean; login: string | null }>('GET', '/logins/gh').then((r) => live && setGh(r), () => undefined);
    return () => {
      live = false;
    };
  }, [app.id]);

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
              help="Railway opens in this tab. You pick the workspaces it may read, as a viewer. Nothing to copy."
              error={quick.error}
            >
              <Button variant="secondary" loading={quick.busy} onClick={() => void quick.run(() => signIn('/logins/railway'))}>Sign in</Button>
            </Choice>
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
              <Button
                variant="secondary"
                loading={quick.busy}
                onClick={() =>
                  void quick.run(async () => {
                    await apply(() => call<Changed>('POST', '/services/github', { fromGh: true }));
                    onClose();
                  })
                }
              >
                Use it
              </Button>
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
