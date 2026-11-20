/**
 * Talk to the connected model with this server's tools, to see how they work for an AI assistant before connecting
 * one (server: core/llm_chat.ts, the /chat route).
 *
 * The model is given the tools that only read, save_note (which writes notes into this server's notes/ folder),
 * and the instructions this server gives every client. Each tool call and what it returned is shown as it happens.
 *
 * Conversations are kept on this machine by the server (admin/chats.ts): the question when it is sent, the answer
 * when it is done. Going to another page of the console does not stop an answer: it is written on, and is there
 * when the conversation is opened again. Closing or reloading the tab does stop it (the request ends), and what was
 * written so far is kept. The address names the conversation (#/chat?c=<id>).
 *
 * Layout: the conversation, and below it a composer that stays at the bottom of the window. While an answer is
 * written the page follows it, unless the person scrolled up to read: then it stays where they are.
 *
 * A command the model asks to run (run_command, server: admin/terminal.ts) is shown on its own card, not folded
 * with the other tool calls: the command in full, why, and where it runs, with Run and Don't run. Nothing runs
 * until Run is pressed. While it runs its output is shown as it comes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { call, chatStream, type ChatEvent, type ChatSummary, type StoredChat, type WaitingCommand } from '../api';
import { AskFirst, Page, useServer } from '../app';
import { Select } from '../ui/select';
import { Markdown } from '../markdown';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { MessageActions } from '../ui/message-actions';
import { TextArea } from '../ui/text-area';
import { Spinner } from '../ui/spinner';
import { ThinkingLoader } from '../ui/thinking-loader';
import { ToolCallCard, ToolCallGroup } from '../ui/tool-call-card';
import { num } from '../format';

interface Call {
  id: string;
  name: string;
  input: unknown;
  startedAt: number;
  result?: { ok: boolean; text: string; ms: number };
  /** run_command: the command as the server asked for it, and how it went. */
  cmd?: { id: string; command: string; why: string; state: WaitingCommand['state']; cwd: string; output: string; exit?: number | null; seconds?: number; note?: string };
}
const COMMAND = 'run_command';
/** What the page keeps of a command's output while it runs: the end, where it is. */
const OUTPUT_CHARS = 100_000;

/** The person's answer to a command. */
const answerCommand = (id: string, run: boolean) => call('POST', `/chat/commands/${id}`, { run });

type CardState = WaitingCommand['state'];
/**
 * One command the chat asks to run. Waiting: the command in full, why, where, and the two answers. Running: the
 * output as it comes. Done: how it ended, and the output folded (open when it failed).
 */
function CommandCard({ command, why, cwd, state, ok, summary, output, note, onAnswer }: {
  command: string;
  why: string;
  cwd?: string;
  state: CardState;
  ok?: boolean;
  summary?: string;
  output?: string;
  /** Not run: why, in a line. */
  note?: string;
  onAnswer?: (run: boolean) => Promise<unknown>;
}) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const out = useRef<HTMLPreElement>(null);
  const card = useRef<HTMLElement>(null);
  const lines = command.split('\n').length;
  // Letters that look like others (a Cyrillic а in an address): the person is told to read closely.
  const unusual = /[^\x20-\x7e\n\t]/.test(command);
  // Asked to answer: the card is read from its top, not from where the page followed the answer to.
  useEffect(() => {
    if (state !== 'waiting' || !onAnswer || !card.current) return;
    if (card.current.getBoundingClientRect().top < 72) card.current.scrollIntoView({ block: 'start' });
  }, [state, onAnswer]);
  useLayoutEffect(() => {
    if (state === 'running' && out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [output, state]);
  const answer = async (run: boolean) => {
    if (!onAnswer) return;
    setSending(true);
    setProblem(null);
    try {
      await onAnswer(run);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  const title =
    state === 'waiting' ? 'Run this command on your computer?' : state === 'running' ? 'Running on your computer' : state === 'declined' ? 'Not run' : ok ? 'Ran on your computer' : 'The command failed';
  return (
    <section ref={card} className="cmd" data-state={state} data-failed={state === 'done' && !ok ? '' : undefined} aria-label={title}>
      <div className="cmd-head">
        <span className="cmd-title">{title}</span>
        {state === 'running' && <Spinner size={13} label="Running" />}
        {(summary || (state === 'waiting' && lines > 1)) && <span className="cmd-summary">{summary ?? `${lines} lines`}</span>}
      </div>
      {why && <p className="cmd-why">{why}</p>}
      <pre className="cmd-line">{command}</pre>
      {state === 'waiting' && (
        <>
          {unusual && <p className="cmd-warn">It has characters other than plain English letters and signs. Check names and addresses letter by letter.</p>}
          <p className="cmd-where">
            It runs {cwd ? <>in <code>{cwd}</code>, </> : ''}with the permissions of the account that started this server.
          </p>
          {onAnswer && (
            <div className="actions">
              <Button size="sm" disabled={sending} onClick={() => void answer(true)}>Run</Button>
              <Button size="sm" variant="ghost" disabled={sending} onClick={() => void answer(false)}>Don't run</Button>
            </div>
          )}
        </>
      )}
      {problem && <p className="error" role="alert">{problem}</p>}
      {state === 'running' && <pre ref={out} className="cmd-output">{output || 'No output yet.'}</pre>}
      {state === 'declined' && note && <p className="cmd-where">{note}</p>}
      {state === 'done' && output && (
        <details className="cmd-more" open={!ok}>
          <summary>Output</summary>
          <pre className="cmd-output">{output}</pre>
        </details>
      )}
    </section>
  );
}

/** How a command ended, in a few words: "exit 0 · 3s". */
const ended = (exit: number | null | undefined, seconds: number | undefined) => `exit ${exit ?? 'none'} · ${seconds ?? 0}s`;
/** What the server told the model about a command that ran or did not, as the card says it. */
function endOf(first: string): { summary?: string; note?: string } {
  const exit = /exit code (\S+) after (\d+) s/.exec(first);
  if (exit) return { summary: ended(exit[1] === 'none' ? null : Number(exit[1]), Number(exit[2])) };
  if (/^It was stopped after/.test(first)) return { summary: 'stopped at the time limit' };
  if (/^It was stopped:/.test(first)) return { summary: 'stopped' };
  if (/^The person chose not/.test(first)) return { note: 'You chose not to run it.' };
  const late = /^No one approved it within (\d+) minutes/.exec(first);
  if (late) return { note: `Not answered within ${late[1]} minutes, so it did not run.` };
  if (/^The conversation was stopped/.test(first)) return { note: 'The conversation was stopped before it ran.' };
  return { note: first };
}

/** A run_command call as its card shows it: from the events while it is live, or from what was kept. */
function cardOf(c: Call, onAnswer: (id: string, run: boolean) => Promise<unknown>) {
  const input = (c.input && typeof c.input === 'object' ? c.input : {}) as { command?: unknown; why?: unknown };
  // What the server will run, as it said so; the model's own words only for a call kept from before.
  const base = c.cmd ? { command: c.cmd.command, why: c.cmd.why } : { command: String(input.command ?? ''), why: String(input.why ?? '') };
  if (c.result) {
    // What came back: its first line says how it ended; the output follows "Output:" when it ran.
    const first = c.result.text.split('\n')[0];
    const at = c.result.text.indexOf('\n\nOutput:\n');
    const ran = c.cmd ? c.cmd.state !== 'declined' && c.cmd.state !== 'waiting' : at >= 0;
    return {
      ...base,
      cwd: c.cmd?.cwd,
      state: (ran ? 'done' : 'declined') as CardState,
      ok: c.result.ok,
      ...endOf(first),
      output: ran ? c.cmd?.output || (at >= 0 ? c.result.text.slice(at + 10) : '') : undefined,
    };
  }
  // Not asked yet (the server checks it first): no answers to give.
  if (!c.cmd) return { ...base, state: 'waiting' as CardState };
  return {
    ...base,
    cwd: c.cmd.cwd,
    state: c.cmd.state,
    output: c.cmd.output,
    note: c.cmd.note,
    summary: c.cmd.state === 'done' ? ended(c.cmd.exit, c.cmd.seconds) : undefined,
    onAnswer: c.cmd.state === 'waiting' ? (run: boolean) => onAnswer(c.cmd!.id, run) : undefined,
  };
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  calls: Call[];
  /** assistant: still being written. */
  live?: boolean;
  /** assistant: what it is doing, in order (the loader shows the last). */
  steps: string[];
  startedAt: number;
  end?: { model: string; usage: { input: number; output: number; cached: number; steps: number }; note: string | null; seconds: number };
  error?: string;
}

/** What a tool call was about, in a line: the first text argument (most tools take a query or an id). */
function about(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 80);
  if (!input || typeof input !== 'object') return '';
  const first = Object.values(input as Record<string, unknown>).find((v) => typeof v === 'string' && v.trim());
  return typeof first === 'string' ? `“${first.length > 70 ? `${first.slice(0, 70)}…` : first}”` : '';
}

/** Tools by where they come from, for the list under the title. */
const SOURCES: Array<{ label: string; test: (name: string) => boolean }> = [
  { label: 'Your documents', test: (n) => ['search_knowledge', 'read_document', 'linked_documents'].includes(n) },
  { label: 'Google Drive', test: (n) => /drive/.test(n) },
  { label: 'Slack', test: (n) => n.startsWith('slack_') },
  { label: 'GitHub', test: (n) => n.startsWith('github_') || n.startsWith('repo_') },
  { label: 'Railway', test: (n) => n.startsWith('railway_') },
];
function grouped(tools: string[]): Array<{ label: string; tools: string[] }> {
  const out = new Map<string, string[]>();
  for (const t of tools) {
    const label = SOURCES.find((s) => s.test(t))?.label ?? (t.includes('_') ? t.slice(0, t.indexOf('_')).replace(/^./, (c) => c.toUpperCase()) : 'Other');
    out.set(label, [...(out.get(label) ?? []), t]);
  }
  return [...out.entries()].map(([label, list]) => ({ label, tools: list }));
}

/** A few questions to start with, from the tools there are. Picking one puts it in the box, to finish or send. */
function suggestions(tools: string[]): string[] {
  const out: string[] = [];
  if (tools.includes('search_knowledge')) out.push('What do my documents say about ');
  if (tools.some((t) => t.startsWith('linear_'))) out.push('What is in progress in Linear right now?');
  if (tools.some((t) => t.startsWith('railway_'))) out.push('Did the latest Railway deploy succeed?');
  if (tools.some((t) => /drive/.test(t))) out.push('Find the newest Drive files about ');
  out.push('What can you look up for me?');
  return out.slice(0, 3);
}

/** A kept message as the page shows it. */
const turnOf = (t: StoredChat['turns'][number]): Turn => ({
  role: t.role,
  text: t.text,
  calls: (t.calls ?? []).map((c) => ({ id: c.id, name: c.name, input: c.input, startedAt: Date.parse(t.at), result: c.ok === undefined ? undefined : { ok: c.ok, text: c.text ?? '', ms: c.ms ?? 0 } })),
  steps: [],
  startedAt: Date.parse(t.at),
  end: t.end,
  error: t.error,
});
/** The conversation the address names. */
const chatInAddress = (): string | null => new URLSearchParams(location.hash.split('?')[1] ?? '').get('c');
const nameInAddress = (id: string | null) => history.replaceState(null, '', id ? `#/chat?c=${id}` : '#/chat');

export function Chat() {
  const { state, go } = useServer();
  const llm = state.services.llm;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  /** The answer in this conversation is still being written by the server (the page was left in the middle). */
  const [elsewhere, setElsewhere] = useState(false);
  /** Its commands that wait for an answer or run, as the server says. */
  const [waiting, setWaiting] = useState<WaitingCommand[]>([]);
  const [draft, setDraft] = useState('');
  const [tools, setTools] = useState<string[] | null>(null);
  const [showTools, setShowTools] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // Follow the answer while it is written, unless the person scrolled up to read.
  const follow = useRef(true);
  const busy = turns.some((t) => t.live);

  useEffect(() => void call<{ tools: string[] }>('GET', '/chat').then((r) => setTools(r.tools), () => setTools([])), [state.tools.length]);

  /** Which opening is the latest: an answer for one asked before it is dropped. */
  const opening = useRef(0);
  const loadList = useCallback(() => call<{ chats: ChatSummary[] }>('GET', '/chats').then((r) => (setChats(r.chats), r.chats), () => [] as ChatSummary[]), []);
  const open = useCallback(async (id: string | null) => {
    const mine = ++opening.current;
    setChatId(id);
    nameInAddress(id);
    if (!id) {
      setTurns([]);
      setElsewhere(false);
      setWaiting([]);
      return;
    }
    try {
      const c = await call<StoredChat>('GET', `/chats/${id}`);
      if (mine !== opening.current) return;
      setTurns(c.turns.map(turnOf));
      setElsewhere(c.answering);
      setWaiting(c.answering ? (c.commands ?? []) : []);
    } catch {
      if (mine !== opening.current) return;
      setTurns([]);
      setElsewhere(false);
      setWaiting([]);
    }
  }, []);
  // The conversation in the address, or the latest one.
  useEffect(() => {
    void loadList().then((list) => void open(chatInAddress() ?? list[0]?.id ?? null));
  }, [loadList, open]);
  // An answer the server is still writing (the page was left in the middle): read the conversation again until it is done.
  useEffect(() => {
    if (!elsewhere || !chatId) return;
    const timer = setInterval(() => void open(chatId), 2000);
    return () => clearInterval(timer);
  }, [elsewhere, chatId, open]);
  useEffect(() => {
    const onScroll = () => {
      const left = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      follow.current = left < 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    // Braces: newer browsers return a promise from scrolling, and an effect may return nothing but its clean-up.
    if (follow.current) void end.current?.scrollIntoView({ block: 'end' });
  }, [turns]);
  // Leaving the page does not stop the answer: the server writes it on and keeps it with the conversation.

  /** Change the answer being written. */
  const update = useCallback(
    (change: (t: Turn) => Turn) =>
      setTurns((all) => {
        const last = all[all.length - 1];
        return last?.role === 'assistant' ? [...all.slice(0, -1), change(last)] : all;
      }),
    [],
  );

  if (!llm.set) {
    return (
      <Page title="Chat" text="Ask the connected model, and watch it use this server's tools.">
        <EmptyState title="No model is connected" text="Connect one on the Models page: your ChatGPT plan, Claude, OpenRouter, OpenAI, or a model on this computer with Ollama." action={<Button onClick={() => go('models')}>Connect a model</Button>} />
      </Page>
    );
  }

  const step = (t: Turn, label: string): Turn => (t.steps[t.steps.length - 1] === label ? t : { ...t, steps: [...t.steps, label] });
  /** Change the command `id` of the answer being written. */
  const command = (t: Turn, id: string, change: (c: NonNullable<Call['cmd']>) => NonNullable<Call['cmd']>): Turn => ({
    ...t,
    calls: t.calls.map((c) => (c.cmd?.id === id ? { ...c, cmd: change(c.cmd) } : c)),
  });
  const take = (e: ChatEvent) => {
    if (e.type === 'text') update((t) => ({ ...t, text: t.text + e.text }));
    else if (e.type === 'thinking') update((t) => step(t, 'Thinking'));
    else if (e.type === 'tool') update((t) => step({ ...t, calls: [...t.calls, { id: e.id, name: e.name, input: e.input, startedAt: Date.now() }] }, `Using ${e.name}`));
    else if (e.type === 'result') update((t) => step({ ...t, calls: t.calls.map((c) => (c.id === e.id ? { ...c, result: { ok: e.ok, text: e.text, ms: e.ms } } : c)) }, 'Reading the results'));
    else if (e.type === 'done') update((t) => ({ ...t, live: false, end: { model: e.model, usage: e.usage, note: e.note, seconds: Math.max(1, Math.round((Date.now() - t.startedAt) / 1000)) } }));
    else if (e.type === 'error') update((t) => ({ ...t, live: false, error: e.message }));
    else if (e.type === 'chat') {
      setChatId(e.id);
      nameInAddress(e.id);
    } else if (e.type === 'approve') {
      update((t) => step({ ...t, calls: t.calls.map((c) => (c.id === e.callId ? { ...c, cmd: { id: e.id, command: e.command, why: e.why, state: 'waiting', cwd: e.cwd, output: '' } } : c)) }, 'Waiting for your answer'));
    } else if (e.type === 'decided') update((t) => step(command(t, e.id, (c) => ({ ...c, state: e.run ? 'running' : 'declined' })), e.run ? 'Running the command' : 'Thinking'));
    else if (e.type === 'output') update((t) => command(t, e.id, (c) => ({ ...c, output: (c.output + e.text).slice(-OUTPUT_CHARS) })));
    else if (e.type === 'ran') update((t) => step(command(t, e.id, (c) => ({ ...c, state: 'done', exit: e.exit, seconds: e.seconds })), 'Reading the results'));
  };

  const send = (text = draft) => {
    const message = text.trim();
    if (!message || busy || elsewhere) return;
    // The server gives the model the conversation so far, from what it kept.
    const now = Date.now();
    setTurns((all) => [...all, { role: 'user', text: message, calls: [], steps: [], startedAt: now }, { role: 'assistant', text: '', calls: [], live: true, steps: ['Thinking'], startedAt: now }]);
    setDraft('');
    follow.current = true;
    const controller = new AbortController();
    stop.current = controller;
    void chatStream({ message, ...(chatId ? { chatId } : {}) }, take, controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) update((t) => ({ ...t, live: false, error: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        update((t) => (t.live ? { ...t, live: false, end: t.end ?? { model: llm.model ?? '', usage: { input: 0, output: 0, cached: 0, steps: 0 }, note: 'Stopped.', seconds: Math.max(1, Math.round((Date.now() - t.startedAt) / 1000)) } } : t));
        // A command still waiting or running when the answer ended was stopped with it: no Run button stays.
        update((t) => ({
          ...t,
          calls: t.calls.map((c) =>
            c.cmd?.state === 'waiting'
              ? { ...c, cmd: { ...c.cmd, state: 'declined', note: 'The conversation was stopped before it ran.' } }
              : c.cmd?.state === 'running'
                ? { ...c, cmd: { ...c.cmd, state: 'done', exit: null } }
                : c,
          ),
        }));
        void loadList();
      });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. Not while a Korean or Japanese word is still being composed.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const suggest = (s: string) => {
    // A question that ends in a space wants finishing; the box takes it with the cursor at the end.
    if (s.endsWith(' ')) {
      setDraft(s);
      requestAnimationFrame(() => {
        box.current?.focus();
        box.current?.setSelectionRange(s.length, s.length);
      });
    } else send(s);
  };

  return (
    <Page title="Chat" text="Ask the connected model. It answers with this server's tools, the way an assistant connected to it would. Conversations are kept on this computer.">
      <div className="chat">
        <div className="chat-bar">
          <span className="chat-model">{llm.model}</span>
          {tools && (
            <button type="button" className="chat-tools-toggle" aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
              {tools.length ? `${num(tools.length)} tool${tools.length === 1 ? '' : 's'}` : 'No tools yet'}
            </button>
          )}
          <span className="chat-bar-gap" />
          {chats.length > 0 && (
            <div className="chat-pick">
              <Select
                size="sm"
                aria-label="Conversation"
                placeholder="Conversations"
                value={chatId}
                disabled={busy}
                onChange={(id) => void open(id)}
                options={chats.slice(0, 100).map((c) => ({ value: c.id, label: `${c.title} · ${new Date(c.updated).toLocaleDateString()}` }))}
              />
            </div>
          )}
          {chatId && !busy && (
            <AskFirst
              label="Delete"
              title="Delete this conversation?"
              text="It is removed from this computer. Notes saved from it stay in the notes folder."
              confirm="Delete"
              onConfirm={async () => {
                await call('DELETE', `/chats/${chatId}`);
                const list = await loadList();
                await open(list[0]?.id ?? null);
              }}
            />
          )}
          {(turns.length > 0 || chatId) && !busy && (
            <Button size="sm" variant="ghost" onClick={() => void open(null)}>New chat</Button>
          )}
        </div>
        {showTools && tools && (
          <div className="chat-tools">
            {grouped(tools).map((g) => (
              <div key={g.label} className="chat-tools-group">
                <span className="chat-tools-label">{g.label}</span>
                <span className="chat-tools-names">{g.tools.join(', ')}</span>
              </div>
            ))}
            <p className="chat-tools-note">
              All of them only read, but save_note, which writes notes into the notes folder of this server
              {tools.includes(COMMAND) ? ', and run_command, which runs a command on this computer only after you press Run' : ''}. Tools that change
              other things are left out: run them yourself on the Tools page.
            </p>
          </div>
        )}

        {turns.length === 0 ? (
          <div className="chat-empty">
            <EmptyState title="Ask something your sources can answer" text="The model looks it up with the tools above. Each call is shown with what it returned." bare />
            {tools && (
              <div className="chat-suggestions">
                {suggestions(tools).map((s) => (
                  <button key={s} type="button" className="chat-suggestion" onClick={() => suggest(s)}>
                    {s.trim()}
                    {s.endsWith(' ') ? '…' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="chat-turns">
            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="chat-user">{t.text}</div>
              ) : (
                <div key={i} className="chat-answer" data-ui-message="">
                  {t.calls.some((c) => c.name !== COMMAND) && (
                    <div className="chat-calls">
                      <ToolCallGroup label={`Used ${t.calls.filter((c) => c.name !== COMMAND).length} tool${t.calls.filter((c) => c.name !== COMMAND).length === 1 ? '' : 's'}`} defaultOpen={false}>
                        {t.calls.filter((c) => c.name !== COMMAND).map((c) => (
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
                    </div>
                  )}
                  {t.calls
                    .filter((c) => c.name === COMMAND)
                    .map((c) => (
                      <CommandCard key={c.id} {...cardOf(c, answerCommand)} />
                    ))}
                  {t.live && !t.text && <ThinkingLoader variant="plain" size="sm" phases={t.steps} phase={t.steps.length - 1} />}
                  {t.text && (
                    <div className="chat-text">
                      <Markdown text={t.text} />
                    </div>
                  )}
                  {t.error && <p className="error" role="alert">{t.error}</p>}
                  {t.end && (
                    <div className="chat-meta">
                      {t.text && <MessageActions text={t.text} actions={['copy']} label="Answer actions" />}
                      <span>
                        {t.end.model} · {t.end.seconds}s · {num(t.end.usage.input)} tokens in{t.end.usage.cached ? ` (${num(t.end.usage.cached)} cached)` : ''}, {num(t.end.usage.output)} out
                        {t.end.note ? ` · ${t.end.note}` : ''}
                      </span>
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        )}
        {elsewhere &&
          waiting.map((c) => (
            <CommandCard
              key={c.id}
              command={c.command}
              why={c.why}
              cwd={c.cwd}
              state={c.state}
              output={c.output}
              onAnswer={
                c.state === 'waiting'
                  ? async (run) => {
                      await answerCommand(c.id, run);
                      if (chatId) await open(chatId);
                    }
                  : undefined
              }
            />
          ))}
        {elsewhere && <p className="field-help">The answer to the last message is still being written. It appears here when it is done.</p>}
        <div ref={end} className="chat-end" />
        <div className="chat-composer">
          <div className="chat-box">
            <TextArea
              ref={box}
              aria-label="Message"
              placeholder={busy ? 'Answering…' : 'Ask about your documents and connected apps'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              minRows={1}
              maxRows={8}
            />
            {busy ? (
              <button type="button" className="chat-send" data-stop="" aria-label="Stop" title="Stop" onClick={() => stop.current?.abort()}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4" y="4" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button type="button" className="chat-send" aria-label="Send" title="Send" disabled={!draft.trim()} onClick={() => send()}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
          <p className="chat-hint">Enter sends, Shift+Enter starts a new line.</p>
        </div>
      </div>
    </Page>
  );
}
