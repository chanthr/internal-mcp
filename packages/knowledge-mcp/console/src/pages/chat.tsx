/**
 * Talk to the connected model with this server's tools, to see how they work for an AI assistant before connecting
 * one (server: core/llm_chat.ts, the /chat route).
 *
 * The model is given the tools that only read, and the instructions this server gives every client. Each tool call
 * and what it returned is shown as it happens. The conversation lives on this page only: nothing is saved.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { call, chatStream, type ChatEvent } from '../api';
import { Page, useServer } from '../app';
import { Markdown } from '../markdown';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Spinner } from '../ui/spinner';
import { TextArea } from '../ui/text-area';
import { ToolCallCard, ToolCallGroup } from '../ui/tool-call-card';

interface Call {
  id: string;
  name: string;
  input: unknown;
  startedAt: number;
  result?: { ok: boolean; text: string; ms: number };
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  calls: Call[];
  /** assistant: still being written. */
  live?: boolean;
  thinking?: boolean;
  end?: { model: string; usage: { input: number; output: number; cached: number; steps: number }; note: string | null };
  error?: string;
}

/** What a tool call was about, in a line: the first text argument (most tools take a query or an id). */
function about(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 80);
  if (!input || typeof input !== 'object') return '';
  const first = Object.values(input as Record<string, unknown>).find((v) => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? `“${first.length > 70 ? `${first.slice(0, 70)}…` : first}”` : '';
}
const count = (n: number) => n.toLocaleString();

export function Chat() {
  const { state, go } = useServer();
  const llm = state.services.llm;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [tools, setTools] = useState<{ tools: string[]; left: number } | null>(null);
  const stop = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.live);

  useEffect(() => void call<{ tools: string[]; left: number }>('GET', '/chat').then(setTools, () => undefined), [state.tools.length]);
  // Keep the newest part in view while it is written. (Braces: newer browsers return a promise from scrolling, and
  // an effect may return nothing but its clean-up.)
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);
  useEffect(() => () => stop.current?.abort(), []);

  if (!llm.set) {
    return (
      <Page title="Chat" text="Ask the connected model, and watch it use this server's tools.">
        <EmptyState title="No model is connected" text="Connect one on the Agent page: Claude, OpenRouter, OpenAI, or a model on this computer with Ollama." action={<Button onClick={() => go('agent')}>Connect a model</Button>} />
      </Page>
    );
  }

  /** Change the answer being written. */
  const update = (change: (t: Turn) => Turn) =>
    setTurns((all) => {
      const last = all[all.length - 1];
      return last?.role === 'assistant' ? [...all.slice(0, -1), change(last)] : all;
    });
  const take = (e: ChatEvent) => {
    if (e.type === 'text') update((t) => ({ ...t, text: t.text + e.text, thinking: false }));
    else if (e.type === 'thinking') update((t) => ({ ...t, thinking: true }));
    else if (e.type === 'tool') update((t) => ({ ...t, thinking: false, calls: [...t.calls, { id: e.id, name: e.name, input: e.input, startedAt: Date.now() }] }));
    else if (e.type === 'result') update((t) => ({ ...t, calls: t.calls.map((c) => (c.id === e.id ? { ...c, result: { ok: e.ok, text: e.text, ms: e.ms } } : c)) }));
    else if (e.type === 'done') update((t) => ({ ...t, live: false, thinking: false, end: { model: e.model, usage: e.usage, note: e.note } }));
    else if (e.type === 'error') update((t) => ({ ...t, live: false, thinking: false, error: e.message }));
  };

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    // What the model is given of the conversation so far: the text of each turn.
    const history = turns.filter((t) => !t.error && t.text.trim()).map((t) => ({ role: t.role, text: t.text }));
    setTurns((all) => [...all, { role: 'user', text: message, calls: [] }, { role: 'assistant', text: '', calls: [], live: true }]);
    setDraft('');
    const controller = new AbortController();
    stop.current = controller;
    void chatStream({ message, history }, take, controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) update((t) => ({ ...t, live: false, error: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => update((t) => (t.live ? { ...t, live: false, end: t.end ?? { model: llm.model ?? '', usage: { input: 0, output: 0, cached: 0, steps: 0 }, note: 'Stopped.' } } : t)));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. Not while a Korean or Japanese word is still being composed.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Page
      title="Chat"
      text={`${llm.model} answers with this server's tools${tools ? `: ${tools.tools.length ? tools.tools.join(', ') : 'none yet'}` : ''}. Tools that change things are left out. Nothing here is saved.`}
    >
      <div className="chat">
        {turns.length === 0 ? (
          <EmptyState title="Ask something your documents answer" text="The model searches and reads them the way an assistant connected to this server would. Each tool call is shown with what it returned." bare />
        ) : (
          <div className="chat-turns">
            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="chat-user">{t.text}</div>
              ) : (
                <div key={i} className="chat-answer">
                  {t.calls.length > 0 && (
                    <ToolCallGroup label={`Used ${t.calls.length} tool${t.calls.length === 1 ? '' : 's'}`} defaultOpen={false}>
                      {t.calls.map((c) => (
                        <ToolCallCard
                          key={c.id}
                          name={c.name}
                          summary={about(c.input)}
                          status={!c.result ? 'running' : c.result.ok ? 'success' : 'error'}
                          args={c.input}
                          result={c.result?.ok ? c.result.text : undefined}
                          error={c.result && !c.result.ok ? c.result.text : undefined}
                          startedAt={c.startedAt}
                          duration={c.result?.ms}
                        />
                      ))}
                    </ToolCallGroup>
                  )}
                  {t.text && <div className="chat-text"><Markdown text={t.text} /></div>}
                  {t.live && !t.text && (
                    <div className="chat-wait">
                      <Spinner /> {t.thinking ? 'Thinking' : t.calls.some((c) => !c.result) ? 'Using tools' : 'Writing'}
                    </div>
                  )}
                  {t.error && <p className="error" role="alert">{t.error}</p>}
                  {t.end && (
                    <p className="chat-meta">
                      {t.end.model} · {count(t.end.usage.input)} tokens in{t.end.usage.cached ? ` (${count(t.end.usage.cached)} cached)` : ''}, {count(t.end.usage.output)} out
                      {t.end.note ? ` · ${t.end.note}` : ''}
                    </p>
                  )}
                </div>
              ),
            )}
            <div ref={end} />
          </div>
        )}
        <div className="chat-input">
          <TextArea
            aria-label="Message"
            placeholder="Ask about your documents"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            minRows={2}
            maxRows={8}
          />
          <div className="chat-actions">
            {turns.length > 0 && !busy && (
              <Button variant="ghost" onClick={() => setTurns([])}>New chat</Button>
            )}
            {busy ? (
              <Button variant="secondary" onClick={() => stop.current?.abort()}>Stop</Button>
            ) : (
              <Button disabled={!draft.trim()} onClick={send}>Send</Button>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
