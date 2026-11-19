import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { call } from '../api';
import { Page, Row, Section, useServer } from '../app';
import { Spinner } from '../ui/spinner';
import { TextField } from '../ui/text-field';

interface Doc {
  id: string;
  title: string;
  path: string;
  in: number;
  out: number;
  /** Named in the header of the linking document (related, parent, …), not in its text. */
  meta?: boolean;
}
interface Summary {
  documents: number;
  links: number;
  unlinked: number;
  broken: number;
  top: Doc[];
  alone: Doc[];
  brokenLinks: Array<{ from: Doc; target: string }>;
}
interface Around {
  node: Doc;
  out: Doc[];
  in: Doc[];
  broken: string[];
}

/** How many documents are drawn on each side. The rest are counted. */
const SHOWN = 12;
const n = (x: number) => x.toLocaleString('en-US');

export function Graph() {
  const { go } = useServer();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [around, setAround] = useState<Around | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Doc[] | null>(null);

  useEffect(() => {
    call<Summary>('GET', '/graph').then(
      (s) => {
        setSummary(s);
        setPicked((p) => p ?? s.top[0]?.id ?? null);
      },
      (e) => setFailed(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(() => {
    if (!picked) return setAround(null);
    let live = true;
    call<Around>('GET', `/graph/node?id=${encodeURIComponent(picked)}`).then((a) => live && setAround(a), () => live && setAround(null));
    return () => {
      live = false;
    };
  }, [picked]);
  useEffect(() => {
    const text = q.trim();
    if (!text) return setFound(null);
    let live = true;
    const t = setTimeout(() => void call<{ found: Doc[] }>('GET', `/graph/find?q=${encodeURIComponent(text)}`).then((r) => live && setFound(r.found), () => undefined), 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  if (failed) return <Page title="Graph" text="How your documents point at each other."><p className="error" role="alert">{failed}</p></Page>;
  if (!summary) return <Page title="Graph" text="How your documents point at each other."><Spinner label="Reading the links" /></Page>;
  if (summary.documents === 0) {
    return (
      <Page title="Graph" text="How your documents point at each other.">
        <div className="rows">
          <Row title="No documents yet" help="Add a folder of Markdown files, or drop files, under Documents. [[Wiki links]], [text](file.md) and header fields such as related become the links." onClick={() => go('documents')} />
        </div>
      </Page>
    );
  }
  const list = found ?? summary.top;
  return (
    <Page title="Graph" text="How your documents point at each other. Read from the links people wrote: [[wiki links]], Markdown links and header fields such as related.">
      <div className="facts">
        <Fact value={summary.documents} label="documents" />
        <Fact value={summary.links} label="links" />
        <Fact value={summary.unlinked} label="with no links" />
        <Fact value={summary.broken} label="links to nowhere" />
      </div>

      <Section title="Look around a document" text="Pick one to see what links to it and what it links to. Click a neighbour to move there.">
        <div className="split graph-split">
          <div>
            <TextField aria-label="Find a document" placeholder="Find a document" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
            <div className="list graph-list">
              <div className="list-group">{found ? (found.length ? 'Found' : 'Nothing by that name') : 'Most linked to'}</div>
              {list.map((d) => (
                <button key={d.id} type="button" className="list-item" aria-current={d.id === picked} onClick={() => setPicked(d.id)} title={d.path}>
                  <span className="graph-name">{d.title}</span>
                  <span className="graph-count">{n(d.in)} in · {n(d.out)} out</span>
                </button>
              ))}
            </div>
          </div>
          {around ? <Neighbours data={around} onPick={setPicked} /> : <div className="around around-empty">Pick a document.</div>}
        </div>
      </Section>

      {(summary.brokenLinks.length > 0 || summary.alone.length > 0) && (
        <Section title="To tidy" text="Nothing here stops search from working. These are the loose ends of the graph.">
          <div className="rows">
            {summary.brokenLinks.length > 0 && (
              <Row
                title={`${n(summary.broken)} link${summary.broken === 1 ? '' : 's'} to a document that is not there`}
                help={<LooseEnds items={summary.brokenLinks.map((b) => ({ key: `${b.from.id}→${b.target}`, text: `${b.from.title} → ${b.target}`, id: b.from.id }))} total={summary.broken} onPick={setPicked} />}
              />
            )}
            {summary.alone.length > 0 && (
              <Row
                title={`${n(summary.unlinked)} document${summary.unlinked === 1 ? '' : 's'} nothing links to, and that link to nothing`}
                help={<LooseEnds items={summary.alone.map((d) => ({ key: d.id, text: d.title, id: d.id }))} total={summary.unlinked} onPick={setPicked} />}
              />
            )}
          </div>
        </Section>
      )}
    </Page>
  );
}

function Fact({ value, label }: { value: number; label: string }) {
  return (
    <div className="fact">
      <b>{n(value)}</b>
      {label}
    </div>
  );
}

function LooseEnds({ items, total, onPick }: { items: Array<{ key: string; text: string; id: string }>; total: number; onPick: (id: string) => void }) {
  return (
    <span className="loose">
      {items.map((it) => (
        <button key={it.key} type="button" className="link" onClick={() => onPick(it.id)}>{it.text}</button>
      ))}
      {total > items.length && <span>and {n(total - items.length)} more</span>}
    </span>
  );
}

/**
 * One document with what links to it on the left and what it links to on the right. Direction is read from the
 * sides, so no arrowheads and no legend. Lines are drawn from where the boxes actually are.
 */
function Neighbours({ data, onPick }: { data: Around; onPick: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const draw = () => {
      const frame = el.getBoundingClientRect();
      const centre = el.querySelector('[data-centre]')?.getBoundingClientRect();
      if (!centre) return;
      const mid = (r: DOMRect) => r.top + r.height / 2 - frame.top;
      const curve = (x1: number, y1: number, x2: number, y2: number) => {
        const h = (x2 - x1) / 2;
        return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + h).toFixed(1)},${y1.toFixed(1)} ${(x2 - h).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
      };
      const next: string[] = [];
      el.querySelectorAll('[data-side="in"]').forEach((node) => {
        const r = node.getBoundingClientRect();
        next.push(curve(r.right - frame.left, mid(r), centre.left - frame.left, mid(centre)));
      });
      el.querySelectorAll('[data-side="out"]').forEach((node) => {
        const r = node.getBoundingClientRect();
        next.push(curve(centre.right - frame.left, mid(centre), r.left - frame.left, mid(r)));
      });
      setLines(next);
    };
    draw();
    const watch = new ResizeObserver(draw);
    watch.observe(el);
    return () => watch.disconnect();
  }, [data]);

  const side = (which: 'in' | 'out', docs: Doc[]) => (
    <div className="around-col" data-col={which}>
      <div className="around-head">{which === 'in' ? `Linked from ${n(docs.length)}` : `Links to ${n(docs.length)}`}</div>
      {docs.slice(0, SHOWN).map((d) => (
        <button key={d.id} type="button" className="around-node" data-side={which} data-meta={d.meta || undefined} onClick={() => onPick(d.id)} title={d.meta ? `${d.path} (named in a header field)` : d.path}>
          {d.title}
        </button>
      ))}
      {docs.length > SHOWN && <div className="around-more">and {n(docs.length - SHOWN)} more</div>}
      {docs.length === 0 && <div className="around-more">{which === 'in' ? 'Nothing links here' : 'Links to nothing'}</div>}
    </div>
  );
  return (
    <div>
      <div className="around" ref={box}>
        <svg className="around-lines" aria-hidden="true">
          {lines.map((d, i) => <path key={i} d={d} />)}
        </svg>
        {side('in', data.in)}
        <div className="around-centre" data-centre>
          <div className="around-title">{data.node.title}</div>
          <div className="around-path">{data.node.path}</div>
        </div>
        {side('out', data.out)}
      </div>
      {[...data.in, ...data.out].some((d) => d.meta) && <p className="field-help around-note">Dashed: named in a header field such as related, not in the text.</p>}
      {data.broken.length > 0 && (
        <p className="field-help around-note">
          Links to a document that is not there: {data.broken.slice(0, 8).join(', ')}
          {data.broken.length > 8 ? ` and ${n(data.broken.length - 8)} more` : ''}
        </p>
      )}
    </div>
  );
}
