import { useEffect, useMemo, useState } from 'react';
import { call, type ToolView } from '../api';
import { Page, useAction, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { TextArea } from '../ui/text-area';
import { TextField } from '../ui/text-field';
import { ToolCallCard } from '../ui/tool-call-card';

interface Ran {
  args: Record<string, unknown>;
  ok: boolean;
  text: string;
  ms: number;
}

export function Tools() {
  const { state, go } = useServer();
  const groups = useMemo(() => {
    const by = new Map<string, ToolView[]>();
    for (const t of state.tools) by.set(t.group ?? 'other', [...(by.get(t.group ?? 'other') ?? []), t]);
    return [...by.entries()];
  }, [state.tools]);
  const [selected, setSelected] = useState<string | null>(state.tools[0]?.name ?? null);
  const tool = state.tools.find((t) => t.name === selected) ?? state.tools[0];

  return (
    <Page title="Tools" text="Everything an AI client can call. Try one here to see what it gets back.">
      {state.tools.length === 0 ? (
        <EmptyState icon={null} title="No tools yet" text="Add documents or connect a database, and its tools appear here." action={<Button size="sm" variant="secondary" onClick={() => go('documents')}>Add documents</Button>} />
      ) : (
        <div className="split">
          <div className="list" role="group" aria-label="Tools">
            {groups.map(([group, tools]) => (
              <div key={group}>
                <div className="list-group">{group}</div>
                {tools.map((t) => (
                  <button key={t.name} type="button" className="list-item" aria-current={t.name === tool?.name} onClick={() => setSelected(t.name)}>
                    <span className="mono">{t.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {tool && <Try key={tool.name} tool={tool} />}
        </div>
      )}
    </Page>
  );
}

/**
 * The answer as a person reads it. A model is sent rows as a compact table (the column names once, a row per line)
 * because room is what it pays for; here the same rows are set in columns. Anything else is shown as it came.
 */
function readable(text: string): string {
  if (!text.startsWith('{"rowCount":')) return text;
  try {
    const t = JSON.parse(text) as { rowCount: number; columns?: string[]; rows?: unknown[][]; rowsChanged?: number; note?: string };
    if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) return text;
    const shown = (v: unknown) => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 60);
    const cells = [t.columns, ...t.rows.map((r) => r.map(shown))];
    const widths = t.columns.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
    const lines = cells.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
    lines.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '));
    return [...lines, '', `${t.rowCount} row${t.rowCount === 1 ? '' : 's'}${t.note ? `. ${t.note}` : ''}`].join('\n');
  } catch {
    return text;
  }
}

/** One tool: what it is, a form made from its inputs, and the answer of a real call. */
function Try({ tool }: { tool: ToolView }) {
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [ran, setRan] = useState<Ran | null>(null);
  const [whole, setWhole] = useState(false);
  const [more, setMore] = useState(false);
  const run = useAction();
  const optional = Object.keys(props).filter((n) => !required.has(n));
  const shown = Object.entries(props).filter(([n]) => required.has(n) || more || optional.length <= 1);
  useEffect(() => setRan(null), [tool.name]);

  const args = () => {
    const out: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(props)) {
      const v = values[name];
      if (v === undefined || v === '') continue;
      out[name] = p.type === 'integer' || p.type === 'number' ? Number(v) : v;
    }
    return out;
  };
  const missing = [...required].some((n) => values[n] === undefined || values[n] === '');

  return (
    <div className="stack">
      <div>
        <div className="actions">
          <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{tool.name}</span>
          {!tool.readOnly && <Badge size="md" tone="warning">Changes data</Badge>}
        </div>
        <p className={whole ? 'muted' : 'muted clamp'} style={{ marginTop: 4 }}>{tool.description}</p>
        {tool.description.length > 150 && (
          <button type="button" className="link" onClick={() => setWhole((w) => !w)}>{whole ? 'Show less' : 'Show all'}</button>
        )}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const a = args();
          void run.run(async () => {
            const r = await call<{ ok: boolean; text: string; ms: number }>('POST', '/run', { name: tool.name, args: a });
            setRan({ args: a, ...r });
          });
        }}
      >
        {shown.map(([name, p]) => {
          const label = name;
          const optional = !required.has(name);
          const set = (v: unknown) => setValues((s) => ({ ...s, [name]: v }));
          if (p.enum) return <Select key={name} label={label} optional={optional} hint={p.description} value={(values[name] as string) ?? null} onChange={(v) => set(v)} options={p.enum.map((v) => ({ value: v, label: v }))} placeholder="Choose" />;
          if (p.type === 'boolean') return <Switch key={name} placement="end" label={label} description={p.description} checked={values[name] === true} onChange={(e) => set(e.target.checked)} />;
          if (name === 'sql' || name === 'query' || name === 'body') {
            return (
              <div key={name} className={name === 'sql' ? 'code-input' : undefined}>
                <TextArea label={label} optional={optional} hint={p.description} minRows={name === 'sql' ? 4 : 2} maxRows={12} value={(values[name] as string) ?? ''} onChange={(e) => set(e.target.value)} spellCheck={false} />
              </div>
            );
          }
          return (
            <TextField
              key={name}
              label={label}
              optional={optional}
              hint={p.description}
              type={p.type === 'integer' || p.type === 'number' ? 'number' : 'text'}
              placeholder={p.default !== undefined ? String(p.default) : undefined}
              value={(values[name] as string) ?? ''}
              onChange={(e) => set(e.target.value)}
            />
          );
        })}
        <div className="actions">
          <Button type="submit" loading={run.busy} disabled={missing}>{tool.readOnly ? 'Run' : 'Run (changes data)'}</Button>
          {optional.length > 1 && (
            <button type="button" className="link" aria-expanded={more} onClick={() => setMore((m) => !m)}>{more ? 'Fewer options' : `${optional.length} more options`}</button>
          )}
          {run.error && <span className="error" role="alert">{run.error}</span>}
        </div>
      </form>
      {ran && <ToolCallCard name={tool.name} status={ran.ok ? 'success' : 'error'} args={ran.args} result={ran.ok ? readable(ran.text) : undefined} error={ran.ok ? undefined : ran.text} duration={ran.ms} defaultOpen maxCodeHeight={420} />}
    </div>
  );
}
