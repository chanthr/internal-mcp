/**
 * Keeping the wiki up to date by itself: after every pass over the folders, the documents added or changed since
 * this was turned on are read into the wiki, a few at a time, up to a number a day.
 *
 * What was waiting when it was turned on is not read by itself. That can be hundreds of documents, and reading
 * costs (the usage of a plan, or an API's money): the person reads those with the button, in batches whose cost
 * they see. A waiting document that changes later counts as changed and is read.
 *
 * A document that failed MOST_TRIES times is left until it changes (the button still reads it). A run that stopped
 * on something every further call would hit too (a limit, a refused key) pauses this for an hour, so a model that
 * is out of usage is not asked again every few minutes.
 *
 * Kept in the data directory (wiki-auto.json), not in .env: it is switched on the Wiki page and takes effect at
 * once, and the waiting list is state, not a setting.
 */
import { dataFile } from '../../core/data_file.js';
import { settingsDir } from '../../core/config.js';
import { llmConfigured } from '../../core/llm.js';
import { scanFoldersSoon } from './folders.js';
import { MOST_TRIES, readWikiState, startWikiRun, wikiDocuments, wikiExists, wikiRun, wikiWaiting, type WikiDoc, type WikiRun, type WikiState } from './wiki.js';

interface AutoState {
  on: boolean;
  /** When it was turned on. */
  since: string | null;
  /** What was waiting then, as it was then (document ID → modified time): left for the button. */
  backlog: Record<string, string>;
  perDay: number;
  /** The day readToday counts. */
  day: string;
  readToday: number;
  /** Not before this, after a run stopped on a failure that would come again. */
  pausedUntil: string | null;
  last: { at: string; read: number; failed: number; stopped: string | null } | null;
}

export const DEFAULT_PER_DAY = 50;
/** Documents one run reads; the next run starts when its pages are in the index. */
const AT_ONCE = 10;
const PAUSE_MS = 60 * 60_000;

const file = dataFile<AutoState>('wiki-auto.json');
const read = (): AutoState => ({ on: false, since: null, backlog: {}, perDay: DEFAULT_PER_DAY, day: '', readToday: 0, pausedUntil: null, last: null, ...(file.read() ?? {}) });
const today = (): string => new Date().toISOString().slice(0, 10);

export interface AutoView {
  on: boolean;
  since: string | null;
  perDay: number;
  readToday: number;
  /** Documents left for the button when it was turned on. */
  backlog: number;
  pausedUntil: string | null;
  last: AutoState['last'];
}
export function autoView(): AutoView {
  const s = read();
  return {
    on: s.on,
    since: s.since,
    perDay: s.perDay,
    readToday: s.day === today() ? s.readToday : 0,
    backlog: Object.keys(s.backlog).length,
    pausedUntil: s.pausedUntil && Date.parse(s.pausedUntil) > Date.now() ? s.pausedUntil : null,
    last: s.last,
  };
}

/** Is this document for an automatic run: not left for the button, and not one that keeps failing as it is. */
const due = (s: AutoState) => (d: WikiDoc, state: WikiState) => {
  if (s.backlog[d.id] === d.modifiedTime) return false;
  const f = state.failed?.[d.id];
  return !(f && f.modified === d.modifiedTime && f.tries >= MOST_TRIES);
};

/** Turn it on (what waits now is left for the button) or off. */
export async function setAuto(on: boolean, perDay?: number, dir: string = settingsDir()): Promise<AutoView> {
  const s = read();
  if (on && !s.on) {
    const { toRead } = wikiExists(dir) ? wikiWaiting(await wikiDocuments(dir), readWikiState()) : { toRead: [] };
    s.backlog = Object.fromEntries(toRead.map((d) => [d.id, d.modifiedTime]));
    s.since = new Date().toISOString();
    s.pausedUntil = null;
  }
  if (!on) {
    s.backlog = {};
    s.since = null;
    s.pausedUntil = null;
  }
  s.on = on;
  if (perDay) s.perDay = perDay;
  file.write(s);
  return autoView();
}

/**
 * After a pass over the folders: read what came since it was turned on, if it is on, a model is connected, nothing
 * else is reading, and there is room left today. Returns the run it started, or null.
 */
export async function maybeRunWiki(dir: string = settingsDir(), log: (...a: unknown[]) => void = () => {}): Promise<WikiRun | null> {
  const s = read();
  if (!s.on || !wikiExists(dir) || !llmConfigured() || wikiRun()?.running) return null;
  if (s.pausedUntil && Date.parse(s.pausedUntil) > Date.now()) return null;
  if (s.day !== today()) {
    s.day = today();
    s.readToday = 0;
    file.write(s);
  }
  const room = s.perDay - s.readToday;
  if (room <= 0) return null;
  const state = readWikiState();
  const pick = due(s);
  const ready = wikiWaiting(await wikiDocuments(dir), state).toRead.filter((d) => pick(d, state));
  if (ready.length === 0) return null;
  log(`wiki: reading ${Math.min(ready.length, room, AT_ONCE)} new or changed document(s)`);
  return startWikiRun(dir, {
    limit: Math.min(room, AT_ONCE),
    only: pick,
    auto: true,
    // The pages go into the index; the pass that does it starts the next run while documents wait.
    afterWrite: () => void scanFoldersSoon().catch(() => undefined),
    onEnd: (r) => {
      const now = read();
      const read_ = Math.max(0, r.done - r.failed.filter((f) => !f.document.startsWith('topic: ')).length);
      if (now.day !== today()) {
        now.day = today();
        now.readToday = 0;
      }
      now.readToday += read_;
      now.last = { at: r.finishedAt ?? new Date().toISOString(), read: read_, failed: r.failed.length, stopped: r.stopped };
      // Stopped on something every call would hit (not by the person): wait before asking again.
      if (r.stopped && !/^Stopped\./.test(r.stopped)) now.pausedUntil = new Date(Date.now() + PAUSE_MS).toISOString();
      file.write(now);
      if (r.stopped) log(`wiki: stopped: ${r.stopped}`);
    },
  });
}
