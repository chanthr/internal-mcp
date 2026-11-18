import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, call, REFUSED, setToken, takeTokenFromAddress, token, type Changed, type State } from './api';
import { Button } from './ui/button';
import { AlertDialog } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { TextField } from './ui/text-field';
import { Overview } from './pages/overview';
import { Documents } from './pages/documents';
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
      // An address with a token pasted into a tab that is already open: take the token and read everything again.
      if (takeTokenFromAddress()) void refresh();
      setPage(pageFromHash());
    };
    // The server no longer accepts the token (another server on this port, or its data folder is new): ask for one.
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
      if (result.note) setNotice(result.note);
      return result;
    },
    [refresh],
  );
  const go = useCallback((id: string) => {
    location.hash = `#/${id}`;
  }, []);
  const server = useMemo<Server | null>(() => (state ? { state, refresh, apply, go } : null), [state, refresh, apply, go]);

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
    <Gate title="Open the console from the terminal">
      <p className="muted">
        When the server starts in a terminal it prints the console address. That address carries the access token: open it once and this
        browser remembers it.
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
          hint="Also in the data folder, in the file console-token."
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
