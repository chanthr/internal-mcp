/**
 * One step with a command-line tool (gcloud, gh), done without going to a terminal: the server runs the command
 * (installing the tool, or the tool's own sign-in), and this shows where the person has to go and waits until the
 * command says it is done.
 */
import { useEffect, useRef, useState } from 'react';
import { call } from './api';
import { LinkButton, useAction } from './app';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

interface CliRun {
  running: boolean;
  url: string | null;
  code: string | null;
  line: string | null;
  ok: boolean | null;
  error: string | null;
  /** install: what would run on this machine (null: nothing this server knows), and the tool's own instructions. */
  command?: string | null;
  page?: string;
}

export function CliStep({
  tool,
  action,
  label,
  onDone,
  onStart,
  autoStart,
}: {
  tool: 'gcloud' | 'gh' | 'cloudflared';
  action: 'install' | 'sign-in';
  label: string;
  /** The command ended well: look at the tool again. */
  onDone: () => void;
  /** The person pressed the button (so the steps after this one may start by themselves). */
  onStart?: () => void;
  /** Start without being pressed: the step before this one was started by the person and has just ended. */
  autoStart?: boolean;
}) {
  const path = `/logins/${tool}/${action}`;
  const [run, setRun] = useState<CliRun | null>(null);
  const start = useAction();
  const done = useRef(onDone);
  done.current = onDone;

  const begin = () =>
    void start.run(async () => {
      const r = await call<CliRun>('POST', path);
      setRun((before) => ({ ...before, ...r }));
      if (!r.running && r.ok) done.current();
    });

  // What is there already: one that was started before the page was opened again is picked up, not started twice.
  // For an install this also says what would run, so the person reads it before pressing.
  const asked = useRef(false);
  useEffect(() => {
    let live = true;
    call<CliRun>('GET', path).then(
      (r) => {
        if (!live) return;
        setRun(r);
        if (autoStart && !r.running && !asked.current) {
          asked.current = true;
          begin();
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const running = !!run?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      call<CliRun>('GET', path).then(
        (r) => {
          setRun(r);
          if (!r.running && r.ok) done.current();
        },
        () => undefined, // the server is busy for a moment: ask again
      );
    }, 1200);
    return () => clearInterval(timer);
  }, [running, path]);

  const cancel = () => void call('DELETE', path).then(() => setRun((r) => (r ? { ...r, running: false, ok: null, error: null } : r)), () => undefined);

  if (running) {
    return (
      <div className="cli-step" role="status">
        {action === 'install' ? (
          <>
            <div className="cli-wait"><Spinner /><span>Installing {tool}. This can take a few minutes.</span></div>
            {run?.line && <p className="field-help mono">{run.line}</p>}
          </>
        ) : tool === 'gh' ? (
          run?.code ? (
            <>
              <p className="field-help">Type this code at GitHub. This page goes on by itself when GitHub has it.</p>
              <div className="one-time-code" aria-label="One-time code">{run.code}</div>
            </>
          ) : (
            <div className="cli-wait"><Spinner /><span>Asking GitHub for a code</span></div>
          )
        ) : (
          <div className="cli-wait"><Spinner /><span>A browser window opened for the sign-in. Finish it there, and this page goes on by itself.</span></div>
        )}
        <div className="actions">
          {action === 'sign-in' && run?.url && (
            <a className="link" href={run.url} target="_blank" rel="noreferrer">
              {tool === 'gh' ? 'Open GitHub' : 'No window opened? Open the sign-in page'}
            </a>
          )}
          <LinkButton onClick={cancel}>Cancel</LinkButton>
        </div>
      </div>
    );
  }

  // Nothing here can install it: say where the tool's own instructions are.
  if (action === 'install' && run && run.command === null) {
    return (
      <p className="field-help">
        This machine has no package manager the console can use (Homebrew, or winget on Windows).{' '}
        <a className="link" href={run.page} target="_blank" rel="noreferrer">How to install {tool}</a>
      </p>
    );
  }
  const failed = start.error ?? (run && run.ok === false ? run.error : null);
  return (
    <div className="cli-step">
      <div>
        <Button
          variant="secondary"
          size="sm"
          loading={start.busy}
          onClick={() => {
            onStart?.();
            begin();
          }}
        >
          {label}
        </Button>
      </div>
      {action === 'install' && run?.command && <p className="field-help">Runs on this machine: <code>{run.command}</code></p>}
      {failed && <p className="error" role="alert">{failed}</p>}
    </div>
  );
}
