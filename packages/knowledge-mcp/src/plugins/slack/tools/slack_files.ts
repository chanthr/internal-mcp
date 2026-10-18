/**
 * slack_find_files / slack_get_file — Slack 파일 검색 + 다운로드 (read-only).
 *
 * - slack_find_files: query 있으면 search.files(User token), 없으면 files.list(Bot token, 필터).
 * - slack_get_file:   files.info 메타 + 텍스트 파일이면 본문 다운로드.
 * 권한 그룹: slack. 채널 범위는 app_users.allowed_slack_channels.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedSlackChannels } from '../../../core/scope.js';
import {
  slackApi,
  downloadSlackFile,
  isTextualMime,
  SlackError,
  loadBotMemberChannelIds,
} from '../api.js';

/* ── slack_find_files ─────────────────────────────────── */

const findInput = z.object({
  query: z.string().optional().describe('Optional. Keyword search on file name/content (requires a User token).'),
  channel: z.string().optional().describe('Optional. Filter by channel ID (C…) (list mode).'),
  user: z.string().optional().describe('Optional. Filter by uploader user ID (list mode).'),
  count: z.number().int().min(1).max(50).default(20).describe('Max number of results (1-50). default 20.'),
});

export const slackFindFilesTool = defineTool({
  name: 'slack_find_files',
  description:
    'Search or list Slack files. With query, runs a keyword search (User token; only files shared in channels the bot is a member of); ' +
    'without it, lists files by channel/user filter (Bot token; conversations the bot was invited to). ' +
    'Pass a fileId from the results to slack_get_file to download the content.',
  input: findInput,
  annotations: { readOnlyHint: true },
  run: (args) => handleSlackFindFiles(args),
});

interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  created?: number;
  user?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
  permalink?: string;
  url_private_download?: string;
}

/** 파일이 공유된 모든 대화 ID (공개 채널 + 비공개 그룹 + DM). 직원 채널 scope 판정용. */
function fileConversationIds(f: SlackFile): string[] {
  return [...(f.channels ?? []), ...(f.groups ?? []), ...(f.ims ?? [])];
}

/**
 * 직원 채널 scope 안에서 이 파일이 보이는가. scope=null(admin·미설정)=전체 허용.
 * 보수적(over-deny): 파일이 공유된 대화가 scope 와 하나도 겹치지 않으면 제한 직원에게 노출하지 않는다.
 */
function fileInScope(f: SlackFile, scope: Set<string> | null): boolean {
  if (!scope) return true;
  return fileConversationIds(f).some((id) => scope.has(id));
}

function mapFile(f: SlackFile) {
  return {
    fileId: f.id,
    name: f.name ?? f.title ?? '(no name)',
    title: f.title ?? null,
    mimetype: f.mimetype ?? null,
    filetype: f.filetype ?? null,
    size: f.size ?? null,
    created: f.created ? new Date(f.created * 1000).toISOString() : null,
    uploader: f.user ?? null,
    channels: f.channels ?? [],
    permalink: f.permalink ?? null,
  };
}

export async function handleSlackFindFiles(args: z.infer<typeof findInput>) {
  const auth = getAuth();
  const { query, channel, user, count } = args;
  const channelScope = allowedSlackChannels(auth);

  // 채널 scope 제한 직원이 scope 밖 channel 을 명시 필터하면 거부 (slack_read_channel 과 동일).
  if (channelScope && channel && !channelScope.has(channel)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `[forbidden] Channel '${channel}' is not accessible with your current permissions.`,
        },
      ],
      isError: true,
    };
  }

  try {
    let files: SlackFile[];
    let mode: string;
    if (query && query.trim().length > 0) {
      mode = 'search.files';
      const res = await slackApi<{ files?: { matches?: SlackFile[] } }>(
        'search.files',
        { query, count },
        'search',
      );
      // search.files 는 User token(xoxp) 권한 — 토큰 소유자의 DM·비공개 채널 파일까지 보인다.
      // 노출 표면 = "봇이 멤버인 채널에 공유된 파일"(slack_search 와 동일 신뢰 경계, 2026-06-19).
      //   - 비공개 채널 공유 파일은 file.groups 에 담긴다 — 과거 channels>0
      //     필터는 이를 전부 떨궈 파일 검색이 사실상 0건이었다.
      //   - DM 전용 파일(ims): conversations.list 에 없는 D… id → botMemberIds 에 부재 → 자연 제외.
      //   - 봇 미초대 비공개 채널 파일: 허가 안 됨 → 제외.
      // files.list(bot token) 모드는 봇이 초대된 대화만 보이므로 이 제한이 자동 적용된다.
      const botMemberIds = await loadBotMemberChannelIds();
      files = (res.files?.matches ?? []).filter((f) =>
        fileConversationIds(f).some((id) => botMemberIds.has(id)),
      );
    } else {
      mode = 'files.list';
      const res = await slackApi<{ files?: SlackFile[] }>(
        'files.list',
        { channel, user, count },
        'bot',
      );
      // files.list 는 봇에게 온 DM 파일까지 돌려준다 — 검색 모드와 같은 경계(봇 멤버 채널에 공유된 파일)로 거른다.
      const botMemberIds = await loadBotMemberChannelIds();
      files = (res.files ?? []).filter((f) => fileConversationIds(f).some((id) => botMemberIds.has(id)));
    }

    // 직원별 Slack 채널 scope 필터 (admin·미설정 = 전체). scope 밖 대화의 파일 제거.
    const visible = files.filter((f) => fileInScope(f, channelScope));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // 걸러진 건수는 돌려주지 않는다(slack_search 가 total 을 뺀 것과 같은 이유).
            { mode, count: visible.length, files: visible.map(mapFile) },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof SlackError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text' as const, text: `[error] ${msg}` }],
      isError: true,
    };
  }
}

/* ── slack_get_file ───────────────────────────────────── */

const getInput = z.object({
  fileId: z.string().min(1).describe('Slack file ID (e.g. F0123ABCD).'),
  maxBytes: z.number().int().min(1).max(1_000_000).default(200_000).describe('Max bytes of text content (default 200000).'),
});

export const slackGetFileTool = defineTool({
  name: 'slack_get_file',
  description:
    'Fetches the metadata + content of one Slack file. Text files (.md/.txt/.csv/.json/code) ' +
    'return their content; binaries such as images and PDFs return metadata + a download URL only. ' +
    'Get fileId from slack_find_files results.',
  input: getInput,
  annotations: { readOnlyHint: true },
  run: (args) => handleSlackGetFile(args),
});

export async function handleSlackGetFile(args: z.infer<typeof getInput>) {
  const auth = getAuth();
  const { fileId, maxBytes } = args;
  const channelScope = allowedSlackChannels(auth);

  try {
    const res = await slackApi<{ file?: SlackFile }>('files.info', { file: fileId }, 'bot');
    const f = res.file;
    if (!f) {
      return {
        content: [{ type: 'text' as const, text: `[not found] file ${fileId}` }],
        isError: true,
      };
    }

    // 신뢰 경계: 봇이 멤버인 채널에 공유된 파일만 (DM 전용 파일 차단 — find_files 와 동일).
    const botMemberIds = await loadBotMemberChannelIds();
    if (!fileConversationIds(f).some((id) => botMemberIds.has(id))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[forbidden] File '${fileId}' is not shared in any channel the bot is a member of.`,
          },
        ],
        isError: true,
      };
    }

    // 직원별 Slack 채널 scope: 이 파일이 보이는 대화가 전부 권한 밖이면 거부.
    if (!fileInScope(f, channelScope)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[forbidden] File '${fileId}' is not accessible with your current permissions (outside the allowed channels).`,
          },
        ],
        isError: true,
      };
    }

    const meta = mapFile(f);
    const textual = isTextualMime(f.mimetype, f.filetype);
    const downloadUrl = f.url_private_download;

    if (textual && downloadUrl) {
      const dl = await downloadSlackFile(downloadUrl, { asText: true, maxBytes });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ...meta, bytes: dl.bytes, truncated: dl.truncated, content: dl.text ?? '' },
              null,
              2,
            ),
          },
        ],
      };
    }

    // 바이너리 — 메타 + 다운로드 URL (Bearer 인증 필요 안내)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ...meta,
              binary: true,
              note: 'Binary file; content not included. Fetch downloadUrl with an Authorization: Bearer <SLACK token> header.',
              downloadUrl: downloadUrl ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof SlackError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text' as const, text: `[error] ${msg}` }],
      isError: true,
    };
  }
}
