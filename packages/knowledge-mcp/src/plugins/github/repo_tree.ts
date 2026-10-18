/**
 * repo_tree(owner, repo, ref?, filterExt?) — GitHub repo 전체 파일 트리(경로 목록).
 *
 * search_code 는 private repo 를 인덱싱하지 않으므로, 사내 코드 질문은
 * "이 트리로 구조 파악 → 필요 파일만 github_get_file_contents 로 조회" 패턴을 쓴다.
 * git/trees?recursive=1 로 한 번에 전체 경로를 받고, node_modules·dist 등 아티팩트는 제외.
 *
 * 토큰: GITHUB_TOKEN (upstream github 과 동일 키). Contents read 권한이면 private 도 트리 조회 가능.
 * 이름에 github_ prefix 를 안 쓰는 이유: github_ 는 원격 GitHub MCP 도구의 prefix 라 이름이 겹칠 수 있다(겹치면 로컬이 이기고 원격 도구가 가려진다).
 */
import { z } from 'zod';
import { defineTool } from '../../plugin/define.js';
import { getAuth } from '../../core/context.js';

const GITHUB_API = 'https://api.github.com';
const MAX_FILES = 600;
const GH_TIMEOUT_MS = 20_000;

/** AbortController timeout 을 건 fetch (hang 방지). */
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
  ref: z.string().optional().describe('브랜치/SHA (생략 시 default branch)'),
  filterExt: z.string().optional().describe('확장자 필터 (쉼표구분, 예: "ts,tsx"). 생략 시 전체'),
});

export const repoTreeTool = defineTool({
  name: 'repo_tree',
  description:
    'GitHub repo 의 전체 파일 트리(경로 목록)를 반환. 사내 코드 질문 시 가장 먼저 호출해 구조를 파악한 뒤, ' +
    '필요한 파일만 github_get_file_contents(owner, repo, path) 로 읽어 답하라. ' +
    'Works with private repos too (search_code cannot index private repos, so use this tree+get combo). ' +
    'filterExt 로 확장자 한정 가능(예: "ts,tsx,py").',
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleRepoTree(args),
});

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!token) throw new Error('[repo_tree] GITHUB_TOKEN / GITHUB_PAT 미설정');
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}

const ARTIFACT_RE = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|coverage|\.git|__pycache__|\.venv|venv)\//;

// GitHub 이름 규칙(영숫자, '.', '_', '-'). 경로 조작('..', '/')으로 다른 API 경로를 부르지 못하게 막는다.
const GH_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

export async function handleRepoTree(args: z.infer<typeof inputSchema>) {
  getAuth();
  const { owner, repo, ref, filterExt } = args;
  if (!GH_NAME_RE.test(owner) || !GH_NAME_RE.test(repo)) {
    return {
      content: [{ type: 'text' as const, text: '[invalid_input] owner/repo 이름 형식이 올바르지 않습니다.' }],
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
          content: [{ type: 'text' as const, text: `[error] repo ${owner}/${repo} 접근 실패 (HTTP ${r.status}). 권한/이름 확인.` }],
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
        content: [{ type: 'text' as const, text: `[error] tree 조회 실패 (HTTP ${tr.status}, ref=${sha})` }],
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
              note: '필요 파일은 github_get_file_contents(owner, repo, path, ref) 로 조회',
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
