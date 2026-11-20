import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, call, REFUSED, setToken, takeTokenFromAddress, token, type Changed, type State, TOKEN_KEY } from './api';
import { Button } from './ui/button';
import { AlertDialog } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { TextField } from './ui/text-field';
import { SegmentedControl } from './ui/segmented-control';
import { Overview } from './pages/overview';
import { Documents } from './pages/documents';
import { AppsAndData } from './pages/apps';
import { Models } from './pages/models';
import { Chat } from './pages/chat';
import { WikiPage } from './pages/wiki';
import { Skills } from './pages/skills';
import { Notes } from './pages/notes';
import { Search } from './pages/search';
import { Connect } from './pages/connect';
import { Tools } from './pages/tools';
import { People } from './pages/people';

// ── The server, as every page sees it ──
interface Server {
  state: State;
  /** Read the state again. */
  refresh: () => Promise<boolean>;
  /**
   * Run a change. When the server restarts to take it in, wait until it is back and read the state again, so the
   * page shows what is true now.
   */
  apply: <T extends Changed>(change: () => Promise<T>) => Promise<T>;
  go: (page: string) => void;
  /**
   * The live checks of everything connected (null while they run). They reach out to each service, so they are
   * run once and kept: coming back to the overview does not ask every service again. A change asks again.
   */
  checks: { lines: CheckLine[]; failed: string | null } | null;
  check: () => void;
}
export interface CheckLine {
  ok: boolean | null;
  what: string;
  text: string;
}
const ServerContext = createContext<Server | null>(null);
export function useServer(): Server {
  const s = useContext(ServerContext);
  if (!s) throw new Error('no server context');
  return s;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The menu, in the order a person sets the server up: what it reads, the models it uses, how search finds, and who
 * may ask it. Pages that belong together are one page, with tabs where both halves are long.
 */
const PAGES: Array<{ group: string | null; items: Array<{ id: string; label: string; render: () => ReactNode }> }> = [
  { group: null, items: [{ id: 'overview', label: 'Overview', render: () => <Overview /> }] },
  {
    group: 'Sources',
    items: [
      { id: 'documents', label: 'Documents', render: () => <Documents /> },
      { id: 'apps', label: 'Apps and data', render: () => <AppsAndData /> },
      { id: 'notes', label: 'Notes', render: () => <Notes /> },
    ],
  },
  {
    group: 'AI',
    items: [
      { id: 'models', label: 'Models', render: () => <Models /> },
      { id: 'chat', label: 'Chat', render: () => <Chat /> },
      { id: 'wiki', label: 'Wiki', render: () => <WikiPage /> },
      { id: 'skills', label: 'Skills', render: () => <Skills /> },
    ],
  },
  { group: 'Search', items: [{ id: 'search', label: 'Search', render: () => <Search /> }] },
  {
    group: 'Share',
    items: [
      { id: 'connect', label: 'Connect', render: () => <Connect /> },
      { id: 'tools', label: 'Tools', render: () => <Tools /> },
      { id: 'people', label: 'People and keys', render: () => <People /> },
    ],
  },
];
const ALL = PAGES.flatMap((g) => g.items);
/** Pages that moved: an old address (a bookmark, a link in a message) opens where the page is now. */
const MOVED: Record<string, string> = { agent: 'models', data: 'apps', graph: 'search?tab=links', activity: 'tools?tab=calls' };
function pageFromHash(): string {
  const id = location.hash.replace(/^#\//, '').split('?')[0];
  if (MOVED[id]) {
    history.replaceState(null, '', `#/${MOVED[id]}`);
    return MOVED[id].split('?')[0];
  }
  return ALL.find((p) => p.id === id)?.id ?? 'overview';
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [gate, setGate] = useState<'loading' | 'token' | 'down' | null>('loading');
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(pageFromHash);
  const [checks, setChecks] = useState<Server['checks']>(null);
  const checking = useRef(false);
  const check = useCallback(() => {
    if (checking.current) return;
    checking.current = true;
    setChecks(null);
    call<{ lines: CheckLine[] }>('GET', '/check')
      .then((r) => setChecks({ lines: r.lines, failed: null }))
      .catch((e) => setChecks({ lines: [], failed: e instanceof Error ? e.message : String(e) }))
      .finally(() => (checking.current = false));
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      setState(await call<State>('GET', '/state'));
      setGate(null);
      return true;
    } catch (e) {
      setGate(e instanceof ApiError && (e.status === 401 || e.status === 403) ? 'token' : 'down');
      return false;
    }
  }, []);
  useEffect(() => {
    void (token() ? refresh() : Promise.resolve(setGate('token')));
    const onHash = () => {
      // An address with a token pasted into a tab that is already open: when the server accepts the token, read
      // everything again with it.
      void takeTokenFromAddress().then((taken) => taken && refresh());
      setPage(pageFromHash());
    };
    // This server no longer accepts the token (its data folder is new, or the token file was made again): ask for one.
    const onRefused = () => setGate('token');
    window.addEventListener('hashchange', onHash);
    window.addEventListener(REFUSED, onRefused);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(REFUSED, onRefused);
    };
  }, [refresh]);

  const apply = useCallback(
    async <T extends Changed>(change: () => Promise<T>): Promise<T> => {
      setNotice(null);
      const result = await change();
      if (result.restarting) {
        setApplying(true);
        try {
          await wait(700); // the server answers, then stops
          let back = false;
          for (let i = 0; i < 80 && !back; i++) {
            try {
              setState(await call<State>('GET', '/state'));
              setGate(null);
              back = true;
            } catch {
              await wait(350);
            }
          }
          if (!back) setGate('down'); // the new settings stopped it from starting: the terminal says why
        } finally {
          setApplying(false);
        }
      } else {
        if (result.restartNeeded) setNotice('Saved. Restart the server to use the change.');
        await refresh();
      }
      // What was done, and what is still to do when nothing restarts the server for us.
      if (result.note) setNotice(result.restartNeeded && !result.restarting ? `${result.note} Restart the server to use the change.` : result.note);
      check(); // what is connected has changed
      return result;
    },
    [refresh, check],
  );
  const go = useCallback((id: string) => {
    location.hash = `#/${id}`;
  }, []);
  // Back from signing in at Railway or Google: the server holds what came back, and this saves it. Said once per
  // return, so a failure (cancelled, refused) is shown and not asked for again.
  const waiting = state?.login?.service ?? null;
  const saving = useRef(false);
  useEffect(() => {
    if (!waiting || saving.current) return;
    saving.current = true;
    apply(() => call<Changed>('POST', '/logins/finish'))
      .catch(async (e) => {
        await refresh();
        setNotice(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        saving.current = false;
      });
  }, [waiting, apply, refresh]);
  const server = useMemo<Server | null>(() => (state ? { state, refresh, apply, go, checks, check } : null), [state, refresh, apply, go, checks, check]);
  // Asked once the console is open, so the answer is there by the time the overview shows it.
  const opened = !!state;
  useEffect(() => {
    if (opened) check();
  }, [opened, check]);

  if (gate === 'loading') return <Gate title="Knowledge MCP"><Spinner label="Loading" /></Gate>;
  if (gate === 'token') return <TokenGate onDone={refresh} />;
  if (gate === 'down' || !server || !state) {
    return (
      <Gate title="The server is not answering">
        <p className="muted">Look at the terminal it runs in: it says why. Start it again there, then try again.</p>
        <div><Button variant="secondary" onClick={() => void refresh()}>Try again</Button></div>
      </Gate>
    );
  }

  const current = ALL.find((p) => p.id === page) ?? ALL[0];
  return (
    <ServerContext.Provider value={server}>
      <div className="shell">
        <nav className="nav" aria-label="Console">
          <div className="brand">
            Knowledge MCP
            <small>{state.version}</small>
          </div>
          {PAGES.map((g, i) => (
            <div className="nav-group" key={i}>
              {g.group && <div className="nav-label">{g.group}</div>}
              {g.items.map((p) => (
                <a key={p.id} className="nav-item" href={`#/${p.id}`} aria-current={p.id === current.id ? 'page' : undefined}>
                  {p.label}
                </a>
              ))}
            </div>
          ))}
          <div className="nav-foot" title="Where .env and mcp.config.json are">{state.dir}</div>
        </nav>
        <main className="sheet">
          <div className="page">
            {applying && (
              <div className="banner" role="status">
                <Spinner /> Applying the change. The server restarts and is back in a moment.
              </div>
            )}
            {!applying && notice && <div className="banner" role="status">{notice}</div>}
            {!state.editable && (
              <div className="banner">The settings come from the MCP_CONFIG_JSON env var, so this page can show them but not change them.</div>
            )}
            {current.render()}
          </div>
        </main>
      </div>
    </ServerContext.Provider>
  );
}

function Gate({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="gate">
      <div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/**
 * No token in this browser yet. The first thing offered needs no looking for anything: the server opens the console
 * itself, in the browser of the person at the machine. A token can still be pasted.
 */
function TokenGate({ onDone }: { onDone: () => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState(false);
  const open = useAction();
  const [opened, setOpened] = useState(false);
  // The console the server opens leaves its token where this tab finds it, when it is the same browser.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_KEY || !e.newValue) return;
      setToken(e.newValue);
      void onDone();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [onDone]);
  return (
    <Gate title="This browser has no access yet">
      <p className="muted">The console is for the person at this computer. The server can open it for you, signed in.</p>
      <div className="stack">
        <div>
          <Button
            loading={open.busy}
            onClick={() =>
              void open.run(async () => {
                setOpened(false);
                const res = await fetch('./open-here', { method: 'POST' });
                if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `The server answered ${res.status}.`);
                setOpened(true);
              })
            }
          >
            Open the console
          </Button>
        </div>
        {open.error ? (
          <p className="error" role="alert">{open.error}</p>
        ) : (
          opened && <p className="field-help">Opened in your default browser. If that is this browser, this tab goes on by itself.</p>
        )}
      </div>
      <div className="or">or paste the token</div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value);
          void onDone().then((ok) => setRefused(!ok));
        }}
      >
        <TextField
          label="Access token"
          hint="It is in the file data/console-token of the server's folder, and in the address the server prints in its terminal (the line that starts with console ·)."
          error={refused ? 'The server did not accept that token.' : undefined}
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setRefused(false);
          }}
        />
        <div><Button type="submit" variant="secondary" disabled={value.trim().length < 20}>Use this token</Button></div>
      </form>
    </Gate>
  );
}

// ── The pieces every page is made of ──

export function Page({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <>
      <header className="page-head">
        <h1>{title}</h1>
        <p>{text}</p>
      </header>
      {children}
    </>
  );
}

export function Section({ title, text, action, children }: { title: string; text?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {text && <p>{text}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Row({ title, help, children, onClick }: { title: ReactNode; help?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  return (
    <div
      className="row"
      data-clickable={onClick ? '' : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
      <div className="row-main">
        <div className="row-title">{title}</div>
        {help && <div className="row-help">{help}</div>}
      </div>
      {children && <div className="row-side" onClick={(e) => e.stopPropagation()}>{children}</div>}
    </div>
  );
}

/** One way of doing something and the button that does it, for a dialog that offers more than one way. */
/** `stacked`: what is chosen goes under the words, across the whole width (a step that shows a code or how far it is). */
export function Choice({ title, help, error, stacked, children }: { title: ReactNode; help?: ReactNode; error?: string | null; stacked?: boolean; children: ReactNode }) {
  return (
    <div className="choice" data-stacked={stacked || undefined}>
      <div className="choice-main">
        <div className="choice-title">{title}</div>
        {error ? <div className="error" role="alert">{error}</div> : help && <div className="choice-help">{help}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * A quiet button that asks first. For what cannot be brought back from here: a saved secret, a query somebody wrote,
 * a key that was handed out. (Removing a folder does not ask: adding it again restores everything.)
 */
export function AskFirst({ label, title, text, confirm, disabled, onConfirm }: { label: string; title: string; text: string; confirm: string; disabled?: boolean; onConfirm: () => Promise<unknown> }) {
  return (
    <AlertDialog
      trigger={<Button size="sm" variant="ghost" disabled={disabled}>{label}</Button>}
      title={title}
      description={text}
      confirmLabel={confirm}
      danger
      onConfirm={onConfirm}
    />
  );
}

/** A button that reads as a link: for a small second step inside a sentence or under a form. */
export function LinkButton({ children, onClick, expanded }: { children: ReactNode; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" className="link" aria-expanded={expanded} onClick={onClick}>
      {children}
    </button>
  );
}

/** One line of a list to pick from (tools, documents): the picked one is marked. */
export function ListItem({ current, title, onClick, children }: { current: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="list-item" aria-current={current} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The halves of a page, under its title. The tab is kept in the address (#/page?tab=…), so a link or a reload opens
 * the same one.
 */
export function Tabs<T extends string>({ label, tabs, children }: { label: string; tabs: Array<{ value: T; label: string }>; children: (tab: T) => ReactNode }) {
  const fromAddress = () => {
    const asked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab');
    return tabs.find((t) => t.value === asked)?.value ?? tabs[0].value;
  };
  const [tab, setTab] = useState<T>(fromAddress);
  useEffect(() => {
    const onHash = () => setTab(fromAddress());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const choose = (t: T) => {
    setTab(t);
    const page = location.hash.split('?')[0] || '#/';
    history.replaceState(null, '', t === tabs[0].value ? page : `${page}?tab=${t}`);
  };
  return (
    <>
      <div className="page-tabs">
        <SegmentedControl<T> aria-label={label} variant="tray" value={tab} onChange={choose} options={tabs} />
      </div>
      {children(tab)}
    </>
  );
}

/** Runs an async action for a button or a form: busy while it runs, and the error it ended with. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}
