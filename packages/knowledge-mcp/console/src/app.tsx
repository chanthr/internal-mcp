import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, call, REFUSED, setToken, takeTokenFromAddress, token, type Changed, type State } from './api';
import { Button } from './ui/button';
import { AlertDialog } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { TextField } from './ui/text-field';
import { Overview } from './pages/overview';
import { Documents } from './pages/documents';
import { Graph } from './pages/graph';
import { Data } from './pages/data';
import { Apps } from './pages/apps';
import { Tools } from './pages/tools';
import { Connect } from './pages/connect';
import { People } from './pages/people';
import { Activity } from './pages/activity';

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

const PAGES: Array<{ group: string | null; items: Array<{ id: string; label: string; render: () => ReactNode }> }> = [
  { group: null, items: [{ id: 'overview', label: 'Overview', render: () => <Overview /> }] },
  {
    group: 'Knowledge',
    items: [
      { id: 'documents', label: 'Documents', render: () => <Documents /> },
      { id: 'graph', label: 'Graph', render: () => <Graph /> },
      { id: 'data', label: 'Databases and APIs', render: () => <Data /> },
      { id: 'apps', label: 'Apps', render: () => <Apps /> },
    ],
  },
  {
    group: 'Use',
    items: [
      { id: 'tools', label: 'Tools', render: () => <Tools /> },
      { id: 'connect', label: 'Connect a client', render: () => <Connect /> },
    ],
  },
  {
    group: 'Manage',
    items: [
      { id: 'people', label: 'People and keys', render: () => <People /> },
      { id: 'activity', label: 'Activity', render: () => <Activity /> },
    ],
  },
];
const ALL = PAGES.flatMap((g) => g.items);
const pageFromHash = () => ALL.find((p) => `#/${p.id}` === location.hash.split('?')[0])?.id ?? 'overview';

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

/** No token in this browser yet: say where it comes from, and take one typed in. */
function TokenGate({ onDone }: { onDone: () => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState(false);
  return (
    <Gate title="This browser needs the access token">
      <p className="muted">
        Go to the terminal window where the server is running. It printed a line that starts with <code>console ·</code> followed by an
        address. Open that address: it carries the token, and this browser remembers it for {location.host}.
      </p>
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
          hint="Or paste the token here. It is in the file data/console-token of the server's folder."
          error={refused ? 'The server did not accept that token.' : undefined}
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setRefused(false);
          }}
          autoFocus
        />
        <div><Button type="submit" disabled={value.trim().length < 20}>Open the console</Button></div>
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

/**
 * A quiet button that asks first. For what cannot be brought back from here: a saved secret, a query somebody wrote,
 * a key that was handed out. (Removing a folder does not ask: adding it again restores everything.)
 */
/** One way of doing something and the button that does it, for a dialog that offers more than one way. */
export function Choice({ title, help, error, children }: { title: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="choice">
      <div className="choice-main">
        <div className="choice-title">{title}</div>
        {error ? <div className="error" role="alert">{error}</div> : help && <div className="choice-help">{help}</div>}
      </div>
      {children}
    </div>
  );
}

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
