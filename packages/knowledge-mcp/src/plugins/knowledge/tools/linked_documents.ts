/**
 * linked_documents — follow the links between documents.
 *
 * Search finds passages by what they say. This finds documents by how they are connected: what a document links
 * to, what links to it, and (without a document) which documents the others point to most. The links are the ones
 * people wrote in Markdown; see ../graph.ts.
 *
 * A caller limited to some folders sees only documents in those folders here too, and counts are of what they see.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../../drive/exclude.js';
import { isLocalId } from '../folders.js';
import { getGraph, type Graph, type GraphEdge, type GraphNode } from '../graph.js';

const DESCRIPTION =
  'Follows the links between documents (the knowledge graph): wiki links, Markdown links and "related" fields that people wrote. ' +
  'With a document ID: what that document links to and what links to it. Use it after search_knowledge to find the pages around a result, ' +
  'or the page everything about a topic hangs from. Without an ID: an overview, with the documents most others link to (good starting points). ' +
  'Read any document it lists with read_document.';

const inputSchema = z.object({
  documentId: z.string().min(1).optional().describe('ID of a document, as search_knowledge shows it (local:folder/path). Leave out for the overview.'),
  limit: z.number().int().min(1).max(100).default(25).describe('How many documents to list per section.'),
});

const NOT_FOUND = 'No such document, or it is outside what you may see.';

/** Who may see a document here: not in an excluded folder, and inside the caller's folders when those are limited. */
export function graphVisibility(): (n: GraphNode) => boolean {
  const scope = allowedDriveFolders(getAuth());
  return (n) => !isExcludedPath(n.path) && isPathInScope(n.path, scope);
}

/** How many visible documents a document links to and is linked from. Null when it has neither. */
export function linkCounts(g: Graph, id: string, visible: (n: GraphNode) => boolean): { out: number; in: number } | null {
  const count = (edges: GraphEdge[] | undefined, end: 'to' | 'from') => (edges ?? []).filter((e) => visible(g.nodes.get(e[end])!)).length;
  const out = count(g.out.get(id), 'to');
  const into = count(g.in.get(id), 'from');
  return out || into ? { out, in: into } : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const line = (i: number, n: GraphNode, note = '') => `${i + 1}. ${n.title}${note} — \`${n.id}\``;

export async function handleLinkedDocuments(args: z.infer<typeof inputSchema>) {
  const { documentId, limit = 25 } = args;
  const g = getGraph();
  const visible = graphVisibility();
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

  if (!documentId) {
    const nodes = [...g.nodes.values()].filter(visible);
    if (nodes.length === 0) return text('No documents with links yet. Links are read from Markdown files in the local folders: [[wiki links]], [text](file.md) and header fields such as related.');
    const seen = new Set(nodes.map((n) => n.id));
    const linksIn = (n: GraphNode) => (g.in.get(n.id) ?? []).filter((e) => seen.has(e.from)).length;
    const edges = nodes.reduce((sum, n) => sum + (g.out.get(n.id) ?? []).filter((e) => seen.has(e.to)).length, 0);
    // Counted in what the caller sees: a document whose every link leads outside their folders is alone to them.
    const alone = nodes.filter((n) => !linkCounts(g, n.id, visible));
    // A link to a document the caller may not see counts like a link to one that is not there: the two must not
    // be told apart, or the answer says which names exist in folders the caller has no business with.
    const hidden = nodes.flatMap((n) => (g.out.get(n.id) ?? []).filter((e) => e.plain && !seen.has(e.to)));
    const broken = [...g.broken.filter((b) => seen.has(b.from)), ...hidden];
    const hubs = nodes.map((n) => ({ n, into: linksIn(n) })).filter((x) => x.into > 0).sort((a, b) => b.into - a.into || a.n.title.localeCompare(b.n.title)).slice(0, limit);
    const lines = ['# How the documents connect', `${plural(nodes.length, 'document')} · ${plural(edges, 'link')} · ${plural(alone.length, 'document')} with no links · ${plural(broken.length, 'link')} to a document that does not exist`];
    if (hubs.length) {
      lines.push('', '## Most linked to', ...hubs.map((x, i) => line(i, x.n, ` (${plural(x.into, 'document')} link here)`)));
      lines.push('', 'To see what a document links to and what links to it, call this again with its ID.');
    } else lines.push('', 'No document links to another yet.');
    return text(lines.join('\n'));
  }

  if (!isLocalId(documentId)) return text('Links are known for documents in the local folders only (IDs that start with "local:").', true);
  const node = g.nodes.get(documentId);
  if (!node || !visible(node)) return text(`[error] ${NOT_FOUND}`, true);
  const ends = (edges: GraphEdge[] | undefined, end: 'to' | 'from') =>
    (edges ?? [])
      .map((e) => ({ n: g.nodes.get(e[end])!, meta: e.meta }))
      .filter((x) => visible(x.n))
      .sort((a, b) => a.n.title.localeCompare(b.n.title));
  const out = ends(g.out.get(documentId), 'to');
  const into = ends(g.in.get(documentId), 'from');
  // What this document links to and the caller may not see is listed with what is not there, as it was written.
  const unseen = (g.out.get(documentId) ?? []).filter((e) => e.plain && !visible(g.nodes.get(e.to)!)).map((e) => e.written);
  const broken = [...new Set([...g.broken.filter((b) => b.from === documentId).map((b) => b.target), ...unseen])];
  const lines = [`# Links of ${node.title}`, `ID: \`${node.id}\``];
  const section = (title: string, list: typeof out) => {
    if (list.length === 0) return;
    lines.push('', `## ${title} (${list.length})`, ...list.slice(0, limit).map((x, i) => line(i, x.n, x.meta ? ' (named in its header)' : '')));
    if (list.length > limit) lines.push(`… and ${list.length - limit} more. Raise limit to see them.`);
  };
  section('Links to', out);
  section('Linked from', into);
  if (broken.length) lines.push('', `## Links to a document that does not exist (${broken.length})`, ...broken.slice(0, limit).map((t) => `- ${t}`));
  if (out.length + into.length === 0) lines.push('', 'Nothing links to this document and it links to nothing.');
  else lines.push('', 'Read any of these with read_document.');
  return text(lines.join('\n'));
}

export const linkedDocumentsTool = defineTool({
  name: 'linked_documents',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleLinkedDocuments(args),
});
