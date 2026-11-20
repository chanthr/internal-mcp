/**
 * Wiki: pages a language model writes from the documents, kept as Markdown beside the settings (server: core/wiki).
 */
import { useEffect, useState } from 'react';
import { call, type Changed } from '../api';
import { LinkButton, Page, Row, Section, useAction, useServer } from '../app';
import { num, plural } from '../format';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';

export function WikiPage() {
  return (
    <Page title="Wiki" text="Pages a language model writes from your documents: one per document, and one per topic that gathers what all of them say.">
      <Wiki />
    </Page>
  );
}

interface WikiRun {
  running: boolean;
  done: number;
  total: number;
  phase: 'reading' | 'writing';
  current: string | null;
  written: number;
  failed: Array<{ document: string; why: string }>;
  usage: { input: number; output: number; calls: number };
  stopped: string | null;
  finishedAt: string | null;
  auto: boolean;
  repaired: number;
}
/** Keeping the wiki up to date by itself (server: wiki_auto.ts). */
interface Auto {
  on: boolean;
  since: string | null;
  perDay: number;
  readToday: number;
  backlog: number;
  pausedUntil: string | null;
  last: { at: string; read: number; failed: number; stopped: string | null } | null;
}
interface WikiStatus {
  exists: boolean;
  path: string;
  documents: number;
  topics: number;
  waiting: number;
  gone: number;
  run: WikiRun | null;
  model: boolean;
  auto: Auto;
  /** Documents that could not be read, as they are now, newest first. */
  failed: Array<{ document: string; why: string; tries: number; at: string }>;
}
/** How many documents one press reads. Reading costs: a person sees what it came to before reading on. */
const BATCH = 25;
/** As the server (wiki_auto.ts DEFAULT_PER_DAY). */
const DEFAULT_PER_DAY = 50;

/** The wiki the model writes from the documents: make it, read documents into it, and see how far a run is. */
function Wiki() {
  const { state, apply, go } = useServer();
  const [wiki, setWiki] = useState<WikiStatus | null>(null);
  const act = useAction();
  const load = () => call<WikiStatus>('GET', '/wiki').then(setWiki, () => undefined);
  // Asked again when the settings change (a model was connected, the folder was made).
  useEffect(() => {
    void load();
  }, [state.services.llm.set, state.folders.length]);
  const running = !!wiki?.run?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [running]);

  const run = wiki?.run ?? null;
  const next = Math.min(wiki?.waiting ?? 0, BATCH);
  const last = run && !run.running ? run : null;
  const auto = wiki?.auto ?? null;
  const switchAuto = (on: boolean) => void act.run(async () => { await call('POST', '/wiki/auto', { on }); await load(); });
  return (
    <Section title="Wiki folder" text="Searched like your other folders, and opens in Obsidian as it is.">
      <div className="rows">
        {!wiki ? null : !wiki.exists ? (
          <Row
            title="No wiki yet"
            help="A folder of Markdown pages with links between them, beside your settings. Your documents are not changed."
          >
            <Button size="sm" variant="secondary" loading={act.busy} disabled={!state.editable} onClick={() => void act.run(async () => { await apply(() => call<Changed>('POST', '/wiki')); await load(); })}>
              Create the wiki
            </Button>
          </Row>
        ) : (
          <Row
            title={wiki.path}
            help={
              running && run ? (
                run.phase === 'writing' ? (
                  <>All {plural(run.total, 'document')} read. Writing the topic pages{run.current ? `: ${run.current}` : ''}</>
                ) : (
                  <>
                    Reading {num(Math.min(run.done + 1, run.total))} of {num(run.total)}
                    {run.current ? `: ${run.current}` : ''}
                  </>
                )
              ) : (
                <>
                  {plural(wiki.documents, 'document')} read, {plural(wiki.topics, 'topic')}.{' '}
                  {wiki.waiting > 0 ? `${plural(wiki.waiting, 'document')} new or changed since.` : wiki.documents > 0 ? 'Nothing new to read.' : 'Nothing is read yet.'}
                  {!wiki.model && (
                    <span className="row-note">
                      A language model reads the documents. <LinkButton onClick={() => go('models')}>Connect one</LinkButton>
                    </span>
                  )}
                  {last && (
                    <span className="row-note">
                      Last run: {plural(last.done - last.failed.filter((f) => !f.document.startsWith('topic: ')).length, 'document')} read with {plural(last.usage.calls, 'question')} to the model (
                      {num(last.usage.input)} tokens in, {num(last.usage.output)} out).
                      {last.stopped ? ` ${last.stopped}` : ''}
                    </span>
                  )}
                  {wiki.failed.length > 0 && (
                    <span className="row-note">
                      Not read: {wiki.failed.slice(0, 3).map((f) => `${f.document} (${f.why}${f.tries > 1 ? `, tried ${f.tries} times` : ''})`).join('; ')}
                      {wiki.failed.length > 3 ? ` and ${wiki.failed.length - 3} more` : ''}
                    </span>
                  )}
                </>
              )
            }
          >
            {running ? (
              <Button size="sm" variant="ghost" onClick={() => void call('POST', '/wiki/stop').then(load, load)}>Stop</Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                loading={act.busy}
                disabled={!wiki.model || next === 0}
                onClick={() => void act.run(async () => { await call('POST', '/wiki/run', { limit: BATCH }); await load(); })}
              >
                {next > 0 ? `Read ${plural(next, 'document')}` : 'Read documents'}
              </Button>
            )}
          </Row>
        )}
        {wiki?.exists && auto && (
          <Row
            title="Keep the wiki up to date"
            help={
              auto.on ? (
                <>
                  Documents added or changed since {new Date(auto.since ?? Date.now()).toLocaleDateString()} are read after each scan, up to {plural(auto.perDay, 'document')} a day ({num(auto.readToday)} today).
                  {auto.backlog > 0 ? ` The ${plural(auto.backlog, 'document')} waiting when this was turned on ${auto.backlog === 1 ? 'is' : 'are'} read with the button.` : ''}
                  {auto.pausedUntil && <span className="row-note">Paused until {new Date(auto.pausedUntil).toLocaleTimeString()}: {auto.last?.stopped}</span>}
                </>
              ) : (
                `Reads documents that are added or changed by itself, up to ${DEFAULT_PER_DAY} a day, with the model on the Models page. What waits now stays for the button.`
              )
            }
          >
            <Switch aria-label="Keep the wiki up to date" checked={auto.on} disabled={!state.editable || !wiki.model || act.busy} onChange={(e) => switchAuto(e.target.checked)} />
          </Row>
        )}
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </Section>
  );
}
