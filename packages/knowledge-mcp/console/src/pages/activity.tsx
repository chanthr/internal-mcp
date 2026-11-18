import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { Page, Section } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';

interface Call {
  tool: string;
  email: string | null;
  role: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
  at: string;
}

/** The two callers that are not people. */
const WHO: Record<string, string> = { 'console@localhost': 'This console', 'local@stdio': 'A client on this machine' };

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Activity() {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const load = useCallback(async () => setCalls((await call<{ calls: Call[] }>('GET', '/activity?limit=100')).calls), []);
  useEffect(() => void load().catch(() => setCalls([])), [load]);

  return (
    <Page title="Activity" text="The latest tool calls. What was asked is not stored, only that it was.">
      <Section title="Latest calls" action={<Button size="sm" variant="ghost" onClick={() => void load()}>Refresh</Button>}>
        {calls?.length === 0 ? (
          <EmptyState icon={null} title="No calls yet" text="When a client uses a tool, or you try one here, the call shows up." />
        ) : (
          <div className="rows">
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Who</th>
                  <th>When</th>
                  <th>Took</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(calls ?? []).map((c, n) => (
                  <tr key={n}>
                    <td className="mono">{c.tool}</td>
                    <td className="muted">{WHO[c.email ?? ''] ?? c.email ?? c.role ?? 'Unknown'}</td>
                    <td className="muted" title={new Date(c.at).toLocaleString()}>{ago(c.at)}</td>
                    <td className="muted">{c.durationMs < 1000 ? `${c.durationMs} ms` : `${(c.durationMs / 1000).toFixed(1)} s`}</td>
                    <td title={c.error ?? undefined}>
                      <Badge size="md" tone={c.ok ? 'success' : 'danger'}>{c.ok ? 'Done' : 'Failed'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
