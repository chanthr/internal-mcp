import type { ReactNode } from 'react';
import { Page, Row, Section, useServer } from '../app';
import { plural } from '../format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

export function Overview() {
  const { state, go, checks, check } = useServer();
  const lines = checks && !checks.failed ? checks.lines : null;
  const failed = checks?.failed ?? null;

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
  const sv = state.services;
  // Apps and data: the built-in apps signed in, the apps added with their own MCP server, and databases and APIs.
  const apps = [sv.slack.set, sv.github.set, sv.railway.set].filter(Boolean).length + state.upstreams.length;
  const data = state.connections.length;
  const sources = apps + data === 0 ? 'Slack, GitHub, Notion, a database or an API. Optional.' : [apps && plural(apps, 'app'), data && plural(data, 'database or API')].filter(Boolean).join(' and ') + ' connected.';
  const llm = sv.llm;

  return (
    <Page title="Overview" text="What this server knows and who can ask it.">
      <Section title="Set up" text="In this order. Only the documents are needed; the rest is optional.">
        <div className="rows">
          <Step n={1} done={!!i && i.documents > 0} title="Documents" help={documents}>
            <Button size="sm" variant="secondary" onClick={() => go('documents')}>{i && i.documents > 0 ? 'Manage' : 'Add documents'}</Button>
          </Step>
          <Step n={2} done={apps + data > 0} title="Apps and data" help={sources}>
            <Button size="sm" variant="secondary" onClick={() => go('apps')}>{apps + data > 0 ? 'Manage' : 'Connect'}</Button>
          </Step>
          <Step n={3} done={llm.set} title="Language model" help={llm.set ? `${llm.model}, for Chat and the wiki.` : 'For Chat and the wiki: your ChatGPT plan, Claude, or a model on this computer. Optional.'}>
            <Button size="sm" variant="secondary" onClick={() => go('models')}>{llm.set ? 'Manage' : 'Connect'}</Button>
          </Step>
          <Step n={4} done={false} title="AI clients" help={tools === 0 ? 'Claude, Cursor and others connect with one press. Tools appear once something is added.' : `Claude, Cursor and others connect with one press, and get ${plural(tools, 'tool')}.`}>
            <Button size="sm" variant="ghost" disabled={tools === 0} onClick={() => go('tools')}>Try a tool</Button>
            <Button size="sm" variant="secondary" onClick={() => go('connect')}>Connect</Button>
          </Step>
        </div>
      </Section>

      <Section
        title="Checks"
        text="Everything connected, asked just now."
        action={<Button size="sm" variant="ghost" onClick={check} disabled={checks === null}>Check again</Button>}
      >
        <div className="rows">
          {failed && <Row title="The checks could not run" help={failed} />}
          {checks === null && <Row title={<span className="actions"><Spinner /> Checking</span>} />}
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

/** A step of setting up: its number, or a check once it is done. */
function Step({ n, done, title, help, children }: { n: number; done: boolean; title: string; help: string; children: ReactNode }) {
  return (
    <Row
      title={
        <span className="step-title">
          <span className="step-mark" data-done={done || undefined} aria-label={done ? 'Done' : `Step ${n}`}>{done ? '✓' : n}</span>
          {title}
        </span>
      }
      help={help}
    >
      {children}
    </Row>
  );
}
