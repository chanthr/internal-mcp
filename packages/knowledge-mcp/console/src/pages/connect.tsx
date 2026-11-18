import { useEffect, useState } from 'react';
import { call } from '../api';
import { Page, Section, useServer } from '../app';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { SegmentedControl } from '../ui/segmented-control';

interface Snippets {
  name: string;
  url: string;
  claudeCode: string;
  claudeDesktop: string;
  cursor: string;
  vscode: string;
  http: string;
}
type Client = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'other';

const WHERE: Record<Client, { text: string; language: string; file?: string; pick: (s: Snippets) => string }> = {
  'claude-code': { text: 'Run this once in a terminal. The server is then there in every project.', language: 'bash', pick: (s) => s.claudeCode },
  'claude-desktop': { text: 'Settings, Developer, Edit Config. Add this and restart Claude.', language: 'json', file: 'claude_desktop_config.json', pick: (s) => s.claudeDesktop },
  cursor: { text: 'Put this in the project, or in your home folder for every project.', language: 'json', file: '.cursor/mcp.json', pick: (s) => s.cursor },
  vscode: { text: 'Put this in the project.', language: 'json', file: '.vscode/mcp.json', pick: (s) => s.vscode },
  other: { text: 'Any client that speaks MCP over HTTP. It needs a key: create one under People and keys.', language: 'json', pick: (s) => s.http },
};

export function Connect() {
  const { go } = useServer();
  const [s, setS] = useState<Snippets | null>(null);
  const [client, setClient] = useState<Client>('claude-code');
  useEffect(() => void call<Snippets>('GET', '/clients').then(setS).catch(() => setS(null)), []);
  const w = WHERE[client];

  return (
    <Page title="Connect a client" text="On this machine a client starts the server itself, so no key is needed.">
      <Section title="This machine">
        <div className="stack">
          <SegmentedControl<Client>
            aria-label="Client"
            variant="tray"
            value={client}
            onChange={setClient}
            options={[
              { value: 'claude-code', label: 'Claude Code' },
              { value: 'claude-desktop', label: 'Claude Desktop' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'vscode', label: 'VS Code' },
              { value: 'other', label: 'Over HTTP' },
            ]}
          />
          <p className="muted">{w.text}</p>
          {s && <CodeBlock code={w.pick(s)} language={w.language} filename={w.file} wrap />}
          {client === 'other' && <div><Button size="sm" variant="secondary" onClick={() => go('people')}>Create a key</Button></div>}
        </div>
      </Section>
      <Section title="Other people, Claude on the web, ChatGPT" text="They reach the server over the internet.">
        <p className="muted">
          Put the server behind HTTPS (the README has a Docker image and deploy notes), then give each person a key. Sign-in with Google replaces
          keys for Claude on the web.
        </p>
      </Section>
    </Page>
  );
}
