/**
 * The Markdown a model writes in an answer, shown as a document: headings, lists, tables, quotes, code blocks with
 * a copy button, and links. Parsed by react-markdown with GitHub's extensions (tables, task lists, strikethrough,
 * bare web addresses). It builds React elements and never inserts HTML, so nothing in an answer can run on the page:
 * HTML written in an answer is shown as the text it is, except <br>, which models put in table cells for a new line.
 *
 * What a page of this console should not do is left out on purpose: images are not loaded (an answer could point
 * the browser anywhere), and a link that is not a web address (a document ID such as local:docs/a.md) is shown as
 * text, with the ID on hover.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './ui/code-block';

/** The text of a node and everything inside it: what a code block holds. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return '';
}

/** An mdast node, as far as the plugin below needs one. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}
/** HTML in an answer: <br> becomes a line break, anything else is kept as plain text (never as HTML). */
function htmlAsText() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type !== 'html') {
        walk(child);
        return child;
      }
      return /^<br\s*\/?>$/i.test((child.value ?? '').trim()) ? { type: 'break' } : { type: 'text', value: child.value ?? '' };
    });
  };
  return (tree: MdNode) => walk(tree);
}

const components: Components = {
  // A fenced block: the console's code block, with its language and a copy button.
  pre: ({ children }) => {
    const code = Array.isArray(children) ? children[0] : children;
    const className = isValidElement(code) ? String((code as ReactElement<{ className?: string }>).props.className ?? '') : '';
    const language = /language-([\w+-]+)/.exec(className)?.[1];
    return <CodeBlock className="md-code" code={textOf(code).replace(/\n$/, '')} language={language} wrap maxHeight={420} />;
  },
  // A table scrolls sideways inside its own frame instead of widening the answer.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span className="md-ref" title={href}>
        {children}
      </span>
    ),
  img: ({ alt }) => <span className="md-ref">{alt ? `[image: ${alt}]` : '[image]'}</span>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {/* Every link target is kept as written: `a` above opens only web addresses and shows anything else as text. */}
      <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} components={components} urlTransform={(url) => url}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
