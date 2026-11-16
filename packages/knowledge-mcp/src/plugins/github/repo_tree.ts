/**
 * repo_tree(owner, repo, ref?, filterExt?): the full file tree (list of paths) of a GitHub repo.
 *
 * search_code does not index private repos, so questions about private code follow the pattern
 * "learn the structure from this tree, then fetch only the files needed with github_get_file_contents".
 * git/trees?recursive=1 returns every path in one call, and artifacts such as node_modules and dist are excluded.
 *
 * Token: GITHUB_PAT, or GITHUB_TOKEN if absent (same key as the remote GitHub MCP, see githubToken in index.ts).
 * With Contents read permission, the tree of a private repo can be read too.
 * Why the name has no github_ prefix: github_ is the prefix of the remote GitHub MCP tools, so names could clash
 * (on a clash the local tool wins and the remote tool is hidden).
 */
import { z } from 'zod';
import { defineTool } from '../../plugin/define.js';
import { githubToken } from './token.js';
import { getAuth } from '../../core/context.js';

const GITHUB_API = 'https://api.github.com';
const MAX_FILES = 600;
const GH_TIMEOUT_MS = 20_000;

/** fetch with an AbortController timeout (prevents hangs). */
async function ghFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`GitHub API timeout ${GH_TIMEOUT_MS}ms (${url})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const inputSchema = z.object({
  owner: z.string().min(1).describe('e.g. my-org'),
  repo: z.string().min(1).describe('e.g. my-repo'),
  ref: z.string().optional().describe('Branch/SHA (default branch if omitted)'),
  filterExt: z.string().optional().describe('Extension filter (comma-separated, e.g. "ts,tsx"). All files if omitted'),
});

export const repoTreeTool = defineTool({
  name: 'repo_tree',
  description:
    'Returns the full file tree (list of paths) of a GitHub repo. For questions about your code, call this first to learn the structure, ' +
    'then read only the files you need with github_get_file_contents(owner, repo, path) and answer. ' +
    'Works with private repos too (search_code cannot index private repos, so use this tree+get combo). ' +
    'Use filterExt to limit by extension (e.g. "ts,tsx,py").',
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleRepoTree(args),
});

function ghHeaders(): Record<string, string> {
  const token = githubToken();
  if (!token) throw new Error('[repo_tree] GITHUB_PAT / GITHUB_TOKEN is not set');
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}

const ARTIFACT_RE = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|coverage|\.git|__pycache__|\.venv|venv)\//;

// GitHub naming rule (alphanumerics, '.', '_', '-'). Blocks path tricks ('..', '/') from reaching other API paths.
const GH_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

export async function handleRepoTree(args: z.infer<typeof inputSchema>) {
  getAuth();
  const { owner, repo, ref, filterExt } = args;
  if (!GH_NAME_RE.test(owner) || !GH_NAME_RE.test(repo)) {
    return {
      content: [{ type: 'text' as const, text: '[invalid_input] owner/repo name format is invalid.' }],
      isError: true,
    };
  }
  const headers = ghHeaders();

  try {
    // default branch resolve
    let sha = ref;
    if (!sha) {
      const r = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}`, headers);
      if (!r.ok) {
        return {
          content: [{ type: 'text' as const, text: `[error] Could not access repo ${owner}/${repo} (HTTP ${r.status}). Check permissions and the name.` }],
          isError: true,
        };
      }
      sha = ((await r.json()) as { default_branch?: string }).default_branch ?? 'main';
    }

    const tr = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      headers,
    );
    if (!tr.ok) {
      return {
        content: [{ type: 'text' as const, text: `[error] Tree lookup failed (HTTP ${tr.status}, ref=${sha})` }],
        isError: true,
      };
    }
    const data = (await tr.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };

    let files = (data.tree ?? [])
      .filter((t) => t.type === 'blob')
      .map((t) => t.path)
      .filter((p) => !ARTIFACT_RE.test(p));

    if (filterExt) {
      const exts = filterExt.split(',').map((e) => e.trim().replace(/^\./, '')).filter(Boolean);
      if (exts.length) files = files.filter((p) => exts.some((e) => p.endsWith('.' + e)));
    }

    const truncated = data.truncated || files.length > MAX_FILES;
    const shown = files.slice(0, MAX_FILES);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              repo: `${owner}/${repo}`,
              ref: sha,
              total_files: files.length,
              shown: shown.length,
              truncated,
              note: 'Fetch the files you need with github_get_file_contents(owner, repo, path, ref)',
              files: shown,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `[error] ${msg}` }], isError: true };
  }
}
