/**
 * The little Markdown a model writes in an answer, shown as text with its emphasis: paragraphs, headings, lists,
 * code blocks, `code`, **bold** and links (web addresses only). Built as React elements, never as HTML, so nothing in an answer can run
 * on the page. Anything it does not know is shown as written.
 */
import type { ReactNode } from 'react';

/** `code`, **bold**, *emphasis* and [text](https://…) inside one line. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    // What is inside bold or emphasis may have code or a link of its own.
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{inline(m[3], k)}</em>);
    // A web address opens in a new tab. Anything else (a document ID like local:docs/a.md) is not a place a
    // browser can go: its text is shown, with the target on hover.
    else if (/^https?:\/\//i.test(m[5]))
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[4]}
        </a>,
      );
    else
      out.push(
        <span key={k} className="md-ref" title={m[5]}>
          {m[4]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const indentOf = (line: string): number => (/^\s*/.exec(line.replace(/\t/g, '    '))?.[0].length ?? 0);

/**
 * The list that starts at line `from`, at this indent: its items, lists nested under them (deeper items), and lines
 * that carry on an item. A blank line between items does not end it, so "1." after "1." keeps counting.
 */
function listAt(lines: string[], from: number, indent: number, key: string): { node: ReactNode; next: number } {
  const first = ITEM.exec(lines[from])!;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items: Array<{ text: string; children: ReactNode[] }> = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    const at = indentOf(line);
    if (!line.trim()) {
      // A blank line: the list goes on if the next line that has something is one of its items or under one.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && indentOf(lines[j]) >= indent && (ITEM.test(lines[j]) || indentOf(lines[j]) > indent) && items.length) {
        i = j;
        continue;
      }
      break;
    }
    if (m && at === indent && /\d/.test(m[2]) === ordered) {
      items.push({ text: m[3], children: [] });
      i++;
    } else if (m && at > indent && items.length) {
      const sub = listAt(lines, i, at, `${key}-${i}`);
      items[items.length - 1].children.push(sub.node);
      i = sub.next;
    } else if (!m && at > indent && items.length) {
      items[items.length - 1].text += ` ${line.trim()}`;
      i++;
    } else break;
  }
  const lis = items.map((it, n) => (
    <li key={`${key}-${n}`}>
      {inline(it.text, `${key}-${n}`)}
      {it.children}
    </li>
  ));
  return { node: ordered ? <ol key={key} start={start === 1 ? undefined : start}>{lis}</ol> : <ul key={key}>{lis}</ul>, next: i };
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    // A fenced code block, to the closing fence or the end (it may still be being written).
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push(
        <pre key={key} className="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // A rule between parts.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key} className="md-h">
          {inline(heading[2], key)}
        </p>,
      );
      i++;
      continue;
    }
    // A list: lines that start with "- ", "* " or "1. ". Deeper lines make a list inside the item above them.
    if (ITEM.test(line)) {
      const list = listAt(lines, i, indentOf(line), key);
      blocks.push(list.node);
      i = list.next;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A paragraph: the lines up to a blank line or another kind of block, line breaks kept.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !ITEM.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {para.flatMap((l, n) => (n ? [<br key={`${key}-br${n}`} />, ...inline(l, `${key}-${n}`)] : inline(l, `${key}-${n}`)))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
