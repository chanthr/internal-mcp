import { useEffect, useMemo, useState } from 'react';
import { call, type Changed, type ConnectionView, type DeclaredTool, type ParamSpec } from '../api';
import { AskFirst, Row, Section, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { SegmentedControl } from '../ui/segmented-control';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { TextArea } from '../ui/text-area';
import { TextField } from '../ui/text-field';

const TYPE_LABEL: Record<ConnectionView['type'], string> = { postgres: 'Postgres', sqlite: 'SQLite', http: 'API' };

/** Databases and APIs, and the tools written on them: the second half of the Apps and data page. */
export function DataSections() {
  const { state, apply } = useServer();
  const [adding, setAdding] = useState(false);
  const [toolFor, setToolFor] = useState<string | null>(null);
  const remove = useAction();

  return (
    <>
      <Section title="Databases and APIs" text="The assistant asks them questions. It cannot change anything unless you say so." action={<Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setAdding(true)}>Add a connection</Button>}>
        {state.connections.length === 0 ? (
          <EmptyState icon={null} title="Nothing connected yet" text="A Postgres database, a SQLite file or an HTTP API." action={<Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setAdding(true)}>Add a connection</Button>} />
        ) : (
          <div className="rows">
            {state.connections.map((c) => (
              <Row
                key={c.name}
                title={<span className="mono">{c.name}</span>}
                help={
                  c.missingEnv.length
                    ? `Waiting for ${c.missingEnv.join(', ')} in .env.`
                    : `${c.description ? `${c.description} · ` : ''}${c.type === 'postgres' ? `connection string in ${c.target}` : c.target}`
                }
              >
                <Badge size="md">{TYPE_LABEL[c.type]}</Badge>
                {c.explore && <Badge size="md" tone="info">Free queries</Badge>}
                {c.missingEnv.length > 0 && <Badge size="md" tone="warning">Not ready</Badge>}
                <AskFirst
                  label="Remove"
                  title={`Remove ${c.name}?`}
                  text={c.type === 'postgres' ? 'The assistant can no longer reach it, and its connection string is deleted from .env.' : 'The assistant can no longer reach it.'}
                  confirm="Remove"
                  disabled={remove.busy || !state.editable}
                  onConfirm={() => remove.run(() => apply(() => call<Changed>('DELETE', `/connections/${c.name}`)))}
                />
              </Row>
            ))}
          </div>
        )}
        {remove.error && <p className="error below" role="alert">{remove.error}</p>}
      </Section>

      <Section
        title="Your tools"
        text="One question each: a query on a database or a request to an API. The assistant fills in the values."
        action={state.connections.length > 0 && <Button size="sm" variant="secondary" disabled={!state.editable} onClick={() => setToolFor(state.connections[0].name)}>New tool</Button>}
      >
        {state.declaredTools.length === 0 ? (
          <EmptyState
            icon={null}
            title="No tools of your own yet"
            text={state.connections.length ? 'Write a query or a request once and the assistant can run it with different values.' : 'Connect a database or an API first.'}
          />
        ) : (
          <div className="rows">
            {state.declaredTools.map((t) => <ToolRow key={t.name} tool={t} />)}
          </div>
        )}
      </Section>

      {adding && <AddConnection onClose={() => setAdding(false)} />}
      {toolFor && <NewTool connection={toolFor} connections={state.connections} onClose={() => setToolFor(null)} />}
    </>
  );
}

function ToolRow({ tool }: { tool: DeclaredTool }) {
  const { state, apply } = useServer();
  const remove = useAction();
  return (
    <Row title={<span className="mono">{tool.name}</span>} help={remove.error ?? tool.description}>
      <span className="mono">{tool.connection}</span>
      {tool.readOnly === false && <Badge size="md" tone="warning">Changes data</Badge>}
      <AskFirst
        label="Remove"
        title={`Remove ${tool.name}?`}
        text="Its query is deleted from mcp.config.json."
        confirm="Remove"
        disabled={remove.busy || !state.editable}
        onConfirm={() => remove.run(() => apply(() => call<Changed>('DELETE', `/tools/${tool.name}`)))}
      />
    </Row>
  );
}

function AddConnection({ onClose }: { onClose: () => void }) {
  const { apply } = useServer();
  const [type, setType] = useState<ConnectionView['type']>('postgres');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [header, setHeader] = useState('');
  const [explore, setExplore] = useState(false);
  const save = useAction();
  const ready = /^[a-z][a-z0-9-]*$/.test(name) && (type === 'postgres' ? url.trim() : type === 'sqlite' ? path.trim() : baseUrl.trim());
  const submit = () =>
    void save.run(async () => {
      const headers: Record<string, string> = {};
      const m = /^([^:]+):\s*(.+)$/.exec(header.trim());
      if (type === 'http' && header.trim()) {
        if (!m) throw new Error('Write the header as Name: value, for example Authorization: Bearer ${CRM_TOKEN}');
        headers[m[1].trim()] = m[2].trim();
      }
      await apply(() => call<Changed>('POST', '/connections', { name, type, url: url || undefined, path: path || undefined, baseUrl: baseUrl || undefined, headers, explore: type !== 'http' && explore }));
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a connection"
      description="It is checked first. Nothing is saved until it answers."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.busy} disabled={!ready} onClick={submit}>Check and save</Button>
        </>
      }
    >
      <div className="stack">
        <SegmentedControl<ConnectionView['type']>
          aria-label="Kind"
          variant="tray"
          value={type}
          onChange={setType}
          options={[
            { value: 'postgres', label: 'Postgres' },
            { value: 'sqlite', label: 'SQLite file' },
            { value: 'http', label: 'HTTP API' },
          ]}
        />
        <TextField label="Name" placeholder="shop" hint="Lowercase letters, digits and dashes. People are given access by this name." value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus />
        {type === 'postgres' && (
          <TextField
            label="Connection string"
            type="password"
            placeholder="postgres://user:password@host:5432/database"
            hint="Saved in .env on this machine and not shown again. Use a database user that can only read."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
        )}
        {type === 'sqlite' && <TextField label="Database file" placeholder="/Users/you/data/app.db" value={path} onChange={(e) => setPath(e.target.value)} />}
        {type === 'http' && (
          <>
            <TextField label="Base URL" placeholder="https://api.example.com/v2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <TextField
              label="Header"
              optional
              placeholder="Authorization: Bearer ${CRM_TOKEN}"
              hint="Write a secret as ${NAME} and put its value in .env. A secret typed here is refused."
              value={header}
              onChange={(e) => setHeader(e.target.value)}
            />
          </>
        )}
        {type !== 'http' && (
          <Switch
            placement="end"
            label="Let the assistant write its own queries"
            description="It can then answer questions nobody prepared a tool for. Queries only read, and it reads whatever this database user can read."
            checked={explore}
            onChange={(e) => setExplore(e.target.checked)}
          />
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}

interface TableInfo {
  name: string;
  kind: string;
  columns: Array<{ name: string; type: string }>;
}

/** Names written as :name in a query, in order of first use (text in quotes is skipped, casts are not names). */
function namesIn(sql: string): string[] {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
  const out: string[] = [];
  for (const m of bare.matchAll(/(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Names written as {name} in a request: in the path, in query values and anywhere in the body. */
function namesInRequest(...parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) for (const m of part.matchAll(/(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** "status={status}" lines as an object. A line without "=" is a mistake worth saying. */
function queryFromLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`Write each query parameter as name=value. This line has no "=": ${line}`);
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function NewTool({ connection, connections, onClose }: { connection: string; connections: ConnectionView[]; onClose: () => void }) {
  const { apply } = useServer();
  const [conn, setConn] = useState(connection);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sql, setSql] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('GET');
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [pick, setPick] = useState('');
  const [changes, setChanges] = useState(true);
  const [types, setTypes] = useState<Record<string, ParamSpec['type']>>({});
  const [optional, setOptional] = useState<Record<string, boolean>>({});
  const [about, setAbout] = useState<Record<string, string>>({});
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [checked, setChecked] = useState<{ ok: boolean; text: string } | null>(null);
  const check = useAction();
  const save = useAction();
  const target = connections.find((c) => c.name === conn);
  const api = target?.type === 'http';
  const names = useMemo(() => (api ? namesInRequest(path, query, method === 'GET' ? '' : body) : namesIn(sql)), [api, sql, path, query, body, method]);

  useEffect(() => {
    setTables(null);
    setChecked(null);
    if (api) return;
    void call<{ tables: TableInfo[] }>('GET', `/connections/${conn}/tables`).then((r) => setTables(r.tables)).catch(() => setTables([]));
  }, [conn, api]);

  // A value in the path is part of the address, so it is always needed. Elsewhere in a request it may be left out.
  const inPath = useMemo(() => namesInRequest(path), [path]);
  const mayBeOptional = (n: string) => api && !inPath.includes(n);

  const tool = (): DeclaredTool => {
    const params = Object.fromEntries(
      names.map((n) => [n, { type: types[n] ?? 'string', ...(about[n]?.trim() ? { description: about[n].trim() } : {}), ...(mayBeOptional(n) && optional[n] ? { required: false } : {}) }]),
    );
    if (!api) return { name, connection: conn, description, params, sql };
    const request: NonNullable<DeclaredTool['request']> = { method, path: path.trim() };
    const q = queryFromLines(query);
    if (Object.keys(q).length) request.query = q;
    if (method !== 'GET' && body.trim()) {
      try {
        request.body = JSON.parse(body);
      } catch {
        throw new Error('The body is not valid JSON.');
      }
    }
    if (pick.trim()) request.pick = pick.trim();
    // Anything but a GET has to say whether it changes data: a POST can be a search or an order.
    return { name, connection: conn, description, params, request, ...(method === 'GET' ? {} : { readOnly: !changes }) };
  };
  const ready = /^[a-z][a-z0-9_]*$/.test(name) && description.trim() && (api ? /^\/\S*$/.test(path.trim()) : sql.trim());
  const edited = () => setChecked(null);

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New tool"
      description={api ? 'A request the assistant can send. Write {name} where a value goes.' : 'A query the assistant can run. Write :name where a value goes.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="secondary"
            loading={check.busy}
            disabled={!ready}
            onClick={() =>
              void check.run(async () => {
                const r = await call<{ ok: boolean; note?: string; problems?: string[] }>('POST', '/tools/check', tool());
                setChecked({ ok: r.ok, text: r.ok ? r.note ?? 'It works.' : (r.problems ?? []).join(' ') });
              })
            }
          >
            Check
          </Button>
          <Button
            loading={save.busy}
            disabled={!ready}
            onClick={() =>
              void save.run(async () => {
                await apply(() => call<Changed>('POST', '/tools', tool()));
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
        {connections.length > 1 && (
          <Select label="Runs on" value={conn} onChange={(v) => setConn(v)} options={connections.map((d) => ({ value: d.name, label: d.name, description: TYPE_LABEL[d.type] }))} />
        )}
        <TextField label="Name" placeholder="orders_by_customer" hint="Lowercase letters, digits and underscores." value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus />
        <TextField label="What it answers" placeholder="Orders of one customer, newest first." hint="The assistant picks a tool by this sentence." value={description} onChange={(e) => setDescription(e.target.value)} />
        {api && (
          <>
            <div className="inline">
              <TextField
                label="Path"
                placeholder="/customers/{id}/orders"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  edited();
                }}
              />
              <SegmentedControl<(typeof METHODS)[number]> aria-label="Method" size="sm" value={method} onChange={(m) => (setMethod(m), edited())} options={METHODS.map((m) => ({ value: m, label: m }))} />
            </div>
            <p className="field-help">Under {target?.target}. The connection's headers are sent with it.</p>
            <div className="code-input">
              <TextArea
                label="Query parameters"
                optional
                placeholder={'status={status}\nlimit=20'}
                hint="One per line, as name=value. A value that is only {name} is left out when the assistant gives none."
                minRows={2}
                maxRows={6}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  edited();
                }}
                spellCheck={false}
              />
            </div>
            {method !== 'GET' && (
              <>
                <div className="code-input">
                  <TextArea
                    label="Body (JSON)"
                    optional
                    placeholder={'{ "email": "{email}", "note": "{note}" }'}
                    hint={'A string that is only "{name}" becomes the value, with its type.'}
                    minRows={3}
                    maxRows={10}
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      edited();
                    }}
                    spellCheck={false}
                  />
                </div>
                <Switch
                  placement="end"
                  label="This request changes data"
                  description="Clients are told, and may ask the person before sending it. Turn it off for a request that only reads, such as a search sent as POST."
                  checked={changes}
                  onChange={(e) => setChanges(e.target.checked)}
                />
              </>
            )}
            <TextField label="Keep only" optional placeholder="data.items" hint="A part of the JSON answer, as a dot path. Leave empty for the whole answer." value={pick} onChange={(e) => setPick(e.target.value)} />
          </>
        )}
        {!api && (
          <div className="code-input">
            <TextArea
              label="Query"
              placeholder={'select id, total, status\nfrom orders\nwhere email = :email\norder by created_at desc'}
              hint={tables === null ? 'Reading the tables…' : tables.length ? `Tables: ${tables.map((t) => `${t.name} (${t.columns.map((c) => c.name).join(', ')})`).join(' · ')}` : 'One statement. It only reads.'}
              minRows={5}
              maxRows={14}
              value={sql}
              onChange={(e) => {
                setSql(e.target.value);
                setChecked(null);
              }}
              spellCheck={false}
            />
          </div>
        )}
        {names.map((n) => (
          <div key={n} className="inline">
            <Select
              label={api ? `Value {${n}}` : `Value :${n}`}
              size="sm"
              value={types[n] ?? 'string'}
              onChange={(v) => setTypes((t) => ({ ...t, [n]: v as ParamSpec['type'] }))}
              options={[
                { value: 'string', label: 'Text' },
                { value: 'integer', label: 'Whole number' },
                { value: 'number', label: 'Number' },
                { value: 'boolean', label: 'Yes or no' },
              ]}
            />
            <TextField
              label="What it is"
              size="sm"
              placeholder="Customer email, e.g. ann@example.com"
              value={about[n] ?? ''}
              onChange={(e) => setAbout((a) => ({ ...a, [n]: e.target.value }))}
            />
            {mayBeOptional(n) && <Switch size="sm" label="Optional" checked={optional[n] === true} onChange={(e) => setOptional((o) => ({ ...o, [n]: e.target.checked }))} />}
          </div>
        ))}
        {checked && <p className={checked.ok ? 'muted' : 'error'} role="status">{checked.text}</p>}
        {(check.error || save.error) && <p className="error" role="alert">{check.error ?? save.error}</p>}
      </div>
    </Dialog>
  );
}
