/**
 * The little Markdown a model writes in an answer, shown as text with its emphasis: paragraphs, headings, lists,
 * code blocks, `code`, **bold** and links. Built as React elements, never as HTML, so nothing in an answer can run
 * on the page. Anything it does not know is shown as written.
 */
import type { ReactNode } from 'react';

/** `code`, **bold**, *emphasis* and [text](https://…) inside one line. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
    else
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[4]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
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
    // A list: lines that start with "- ", "* " or "1. ", with the lines indented under them.
    const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = /\d/.test(item.exec(line)![2]);
      const items: ReactNode[] = [];
      while (i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = item.exec(lines[i]);
        const text = m ? m[3] : lines[i].trim();
        items.push(<li key={`${key}-${i}`}>{inline(text, `${key}-${i}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A paragraph: the lines up to a blank line or another kind of block, line breaks kept.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !item.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {para.flatMap((l, n) => (n ? [<br key={`${key}-br${n}`} />, ...inline(l, `${key}-${n}`)] : inline(l, `${key}-${n}`)))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
