import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { AskFirst, Page, Row, Section, useAction } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { Select } from '../ui/select';
import { TextField } from '../ui/text-field';

interface User {
  email: string;
  role: string;
  allowedTools?: string[] | null;
}
interface Key {
  id: string;
  email: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
}
interface PeopleData {
  users: User[];
  keys: Key[];
  groups: string[];
}

export function People() {
  const [data, setData] = useState<PeopleData | null>(null);
  const [newKey, setNewKey] = useState(false);
  const [newPerson, setNewPerson] = useState(false);
  const load = useCallback(async () => setData(await call<PeopleData>('GET', '/people')), []);
  useEffect(() => void load().catch(() => setData({ users: [], keys: [], groups: [] })), [load]);
  const act = useAction();
  const active = (data?.keys ?? []).filter((k) => k.active);

  return (
    <Page title="People and keys" text="On this machine nobody needs a key. Other people and remote clients do.">
      <Section title="Keys" text="A key lets one person's client in. It is shown once." action={<Button size="sm" variant="secondary" onClick={() => setNewKey(true)}>New key</Button>}>
        {active.length === 0 ? (
          <EmptyState icon={null} title="No keys yet" text="Create one for each person or client that connects over HTTP." />
        ) : (
          <div className="rows">
            {active.map((k) => (
              <Row key={k.id} title={k.email ?? 'No owner'} help={`${k.label ?? 'key'} · created ${new Date(k.createdAt).toLocaleDateString()}`}>
                <AskFirst
                  label="Revoke"
                  title="Revoke this key?"
                  text="The client that uses it stops working at once. A revoked key cannot be turned back on."
                  confirm="Revoke"
                  disabled={act.busy}
                  onConfirm={() => act.run(async () => { await call('POST', `/people/keys/${k.id}/revoke`); await load(); })}
                />
              </Row>
            ))}
          </div>
        )}
      </Section>

      <Section title="People" text="A member uses every tool unless you limit them. An admin always uses all." action={<Button size="sm" variant="secondary" onClick={() => setNewPerson(true)}>Add a person</Button>}>
        {(data?.users ?? []).length === 0 ? (
          <EmptyState icon={null} title="Nobody is registered" text="People appear here when they get a key." />
        ) : (
          <div className="rows">
            {(data?.users ?? []).map((u) => (
              <Row key={u.email} title={u.email} help={u.role === 'admin' ? 'Every tool' : u.allowedTools?.length ? `Only: ${u.allowedTools.join(', ')}` : 'Every tool'}>
                <Badge size="md">{u.role === 'admin' ? 'Admin' : 'Member'}</Badge>
                <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => void act.run(async () => { await call('DELETE', `/people/users/${encodeURIComponent(u.email)}`); await load(); })}>Remove</Button>
              </Row>
            ))}
          </div>
        )}
        {act.error && <p className="error" style={{ marginTop: 8 }}>{act.error}</p>}
      </Section>

      {newKey && <NewKey onClose={() => { setNewKey(false); void load(); }} />}
      {newPerson && data && <NewPerson groups={data.groups} onClose={() => { setNewPerson(false); void load(); }} />}
    </Page>
  );
}

function NewKey({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const create = useAction();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={key ? 'Copy the key now' : 'New key'}
      description={key ? 'It is not shown again. Only a fingerprint of it is stored.' : 'The key acts as this person.'}
      footer={
        key ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button loading={create.busy} disabled={!/^\S+@\S+\.\S+$/.test(email)} onClick={() => void create.run(async () => setKey((await call<{ key: string }>('POST', '/people/keys', { email })).key))}>
              Create
            </Button>
          </>
        )
      }
    >
      {key ? (
        <TextField label="Key" value={key} readOnly copyable onFocus={(e) => e.target.select()} />
      ) : (
        <TextField label="Email" type="email" placeholder="ann@example.com" error={create.error ?? undefined} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      )}
    </Dialog>
  );
}

function NewPerson({ groups, onClose }: { groups: string[]; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [tools, setTools] = useState('');
  const save = useAction();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a person"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!/^\S+@\S+\.\S+$/.test(email)}
            onClick={() =>
              void save.run(async () => {
                const list = tools.split(',').map((t) => t.trim()).filter(Boolean);
                await call('POST', '/people/users', { email, role, tools: role === 'admin' ? null : list });
                onClose();
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Email" type="email" placeholder="ann@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Select label="Role" value={role} onChange={(v) => setRole(v)} options={[{ value: 'member', label: 'Member', description: 'Uses the tools you allow' }, { value: 'admin', label: 'Admin', description: 'Uses every tool' }]} />
        {role === 'member' && (
          <TextField label="Limit to" optional placeholder={groups.slice(0, 2).join(', ')} hint={`Leave empty for every tool. Groups: ${groups.join(', ')}`} error={save.error ?? undefined} value={tools} onChange={(e) => setTools(e.target.value)} />
        )}
      </div>
    </Dialog>
  );
}
