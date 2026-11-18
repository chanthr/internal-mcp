import { useState } from 'react';
import { call, type Changed, type State } from '../api';
import { AskFirst, Page, Row, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { TextField } from '../ui/text-field';

type AppId = 'slack' | 'github' | 'railway';
const APPS: Array<{ id: AppId; name: string; gives: string; token: string; hint: string }> = [
  { id: 'slack', name: 'Slack', gives: 'Channels, threads, files and search. It only reads.', token: 'Bot token', hint: 'Starts with xoxb-. From a Slack app installed in your workspace.' },
  { id: 'github', name: 'GitHub', gives: 'Repositories, issues and pull requests. It only reads.', token: 'Personal access token', hint: 'A fine-grained token with read access to the repositories is enough.' },
  { id: 'railway', name: 'Railway', gives: 'Services, deployments and logs.', token: 'Token', hint: 'An account or a project token.' },
];

export function Apps() {
  const { state } = useServer();
  const [open, setOpen] = useState<AppId | null>(null);
  const app = APPS.find((a) => a.id === open);
  return (
    <Page title="Apps" text="Other places the assistant can look. Each one needs a token, checked before it is saved.">
      <div className="rows">
        {APPS.map((a) => <AppRow key={a.id} app={a} set={state.services[a.id].set} onConnect={() => setOpen(a.id)} />)}
      </div>
      {app && <Connect app={app} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function AppRow({ app, set, onConnect }: { app: (typeof APPS)[number]; set: boolean; onConnect: () => void }) {
  const { state, apply } = useServer();
  const off = useAction();
  const plugin = state.plugins.find((p: State['plugins'][number]) => p.id === app.id);
  return (
    <Row title={app.name} help={off.error ?? app.gives}>
      {set && <Badge size="md" tone={plugin?.enabled === false ? 'warning' : 'success'}>{plugin?.enabled === false ? 'Not ready' : 'Connected'}</Badge>}
      {set && (
        <AskFirst
          label="Disconnect"
          title={`Disconnect ${app.name}?`}
          text="Its tools go away and the token is deleted from .env on this machine."
          confirm="Disconnect"
          disabled={off.busy}
          onConfirm={() => off.run(() => apply(() => call<Changed>('DELETE', `/services/${app.id}`)))}
        />
      )}
      <Button size="sm" variant="secondary" onClick={onConnect}>{set ? 'Replace token' : 'Connect'}</Button>
    </Row>
  );
}

function Connect({ app, onClose }: { app: (typeof APPS)[number]; onClose: () => void }) {
  const { apply } = useServer();
  const [token, setToken] = useState('');
  const save = useAction();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Connect ${app.name}`}
      description="The token is checked with the service, then saved in .env on this machine. It is not shown again."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={token.trim().length < 10}
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
      <TextField label={app.token} type="password" hint={app.hint} error={save.error ?? undefined} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus />
    </Dialog>
  );
}
