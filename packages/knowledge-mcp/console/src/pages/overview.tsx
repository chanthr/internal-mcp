import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { Page, Row, Section, useServer } from '../app';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface Line {
  ok: boolean | null;
  what: string;
  text: string;
}

export function Overview() {
  const { state, go } = useServer();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const check = useCallback(async () => {
    setLines(null);
    setFailed(null);
    try {
      setLines((await call<{ lines: Line[] }>('GET', '/check')).lines);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void check(), [check]);

  // What is not set up is not a failed check: the rows above say what can be added.
  const connected = lines
    ?.filter((l) => l.ok !== null)
    .map((l) => {
      const tool = /^›\s+(\S+)\s+(.*)$/.exec(l.text);
      if (tool) return { ok: l.ok === true, title: <span className="mono">{tool[1]}</span>, text: `Tool on ${l.what}: ${tool[2]}` };
      const names: Record<string, string> = { folder: 'Folder', drive: 'Google Drive', embeddings: 'Search by meaning', slack: 'Slack', github: 'GitHub', railway: 'Railway' };
      return { ok: l.ok === true, title: names[l.what] ?? <span className="mono">{l.what}</span>, text: l.text };
    });

  const i = state.index;
  const documents = !i || i.documents === 0 ? 'Nothing to search yet. Add a folder of documents to start.' : `${i.documents.toLocaleString()} documents, searched by ${i.meaning ? 'keywords and meaning' : 'keywords'}.`;
  const tools = state.tools.length;
  const connections = state.connections.length;

  return (
    <Page title="Overview" text="What this server knows and who can ask it.">
      <Section title="Set up">
        <div className="rows">
          <Row title="Documents" help={documents}>
            <Button size="sm" variant="secondary" onClick={() => go('documents')}>{i && i.documents > 0 ? 'Manage' : 'Add documents'}</Button>
          </Row>
          <Row
            title="Databases and APIs"
            help={connections === 0 ? 'None connected. Connect one and ask questions of your own data.' : `${connections} connected.`}
          >
            <Button size="sm" variant="secondary" onClick={() => go('data')}>{connections ? 'Manage' : 'Connect'}</Button>
          </Row>
          <Row title="Tools" help={tools === 0 ? 'No tools yet. They appear when something is connected.' : `${tools} tools an AI client can call.`}>
            <Button size="sm" variant="secondary" onClick={() => go('tools')}>Try one</Button>
          </Row>
          <Row title="AI clients" help="Claude, Cursor and others connect with one line.">
            <Button size="sm" variant="secondary" onClick={() => go('connect')}>Connect</Button>
          </Row>
        </div>
      </Section>

      <Section
        title="Checks"
        text="Everything connected, asked just now."
        action={<Button size="sm" variant="ghost" onClick={() => void check()} disabled={lines === null && !failed}>Check again</Button>}
      >
        <div className="rows">
          {failed && <Row title="The checks could not run" help={failed} />}
          {!failed && lines === null && <Row title={<span className="actions"><Spinner /> Checking</span>} />}
          {connected?.length === 0 && <Row title="Nothing is connected yet" help="Checks appear here once something is." />}
          {connected?.map((l, n) => (
            <Row key={n} title={l.title} help={l.text}>
              <Badge size="md" tone={l.ok ? 'success' : 'danger'}>{l.ok ? 'Works' : 'Needs attention'}</Badge>
            </Row>
          ))}
        </div>
      </Section>
    </Page>
  );
}
