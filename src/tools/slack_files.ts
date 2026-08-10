/**
 * slack_find_files / slack_get_file — Slack 파일 검색 + 다운로드 (read-only).
 *
 * - slack_find_files: query 있으면 search.files(User token), 없으면 files.list(Bot token, 필터).
 * - slack_get_file:   files.info 메타 + 텍스트 파일이면 본문 다운로드.
 * Role: 모든 role 허용.
 */
import { z } from 'zod';
import { getAuth } from '../lib/context.js';
import { allowedSlackChannels } from '../lib/scope.js';
import {
  slackApi,
  downloadSlackFile,
  isTextualMime,
  SlackError,
  loadBotMemberChannelIds,
} from '../integrations/slack.js';

/* ── slack_find_files ─────────────────────────────────── */

export const slackFindFilesTool = {
  name: 'slack_find_files',
  description:
    'Slack 파일을 검색/목록. query 가 있으면 키워드 검색(User token — 봇이 멤버인 채널에 공유된 파일만), ' +
    '없으면 채널/유저 필터로 목록(Bot token — 봇이 초대된 대화). ' +
    '결과의 fileId 를 slack_get_file 에 넘겨 본문 다운로드.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '선택. 파일명/내용 키워드 검색 (User token 필요).' },
      channel: { type: 'string', description: '선택. 채널 ID(C…) 로 필터 (목록 모드).' },
      user: { type: 'string', description: '선택. 업로더 user ID 로 필터 (목록 모드).' },
      count: { type: 'number', description: '최대 결과 수 (1-50). default 20.' },
    },
  },
};

const findInput = z.object({
  query: z.string().optional(),
  channel: z.string().optional(),
  user: z.string().optional(),
  count: z.number().int().min(1).max(50).default(20),
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
    name: f.name ?? f.title ?? '(이름 없음)',
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

export async function handleSlackFindFiles(args: unknown) {
  const auth = getAuth();
  const { query, channel, user, count } = findInput.parse(args);
  const channelScope = allowedSlackChannels(auth);

  // 채널 scope 제한 직원이 scope 밖 channel 을 명시 필터하면 거부 (slack_read_channel 과 동일).
  if (channelScope && channel && !channelScope.has(channel)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `[forbidden] 채널 '${channel}' 은 현재 직원 권한으로 접근 불가입니다.`,
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
      files = res.files ?? [];
    }

    // 직원별 Slack 채널 scope 필터 (admin·미설정 = 전체). scope 밖 대화의 파일 제거.
    const visible = files.filter((f) => fileInScope(f, channelScope));
    const filteredOut = files.length - visible.length;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { mode, count: visible.length, filteredOut, files: visible.map(mapFile) },
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

export const slackGetFileTool = {
  name: 'slack_get_file',
  description:
    'Slack 파일 1개의 메타데이터 + 본문을 가져온다. 텍스트 파일(.md/.txt/.csv/.json/코드)은 ' +
    '본문을 반환하고, 이미지·PDF 등 바이너리는 메타 + 다운로드 URL 만 반환. ' +
    'fileId 는 slack_find_files 결과에서 얻는다.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fileId: { type: 'string', description: 'Slack 파일 ID (예: F0123ABCD).' },
      maxBytes: { type: 'number', description: '텍스트 본문 최대 바이트 (default 200000).' },
    },
    required: ['fileId'],
  },
};

const getInput = z.object({
  fileId: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_000_000).default(200_000),
});

export async function handleSlackGetFile(args: unknown) {
  const auth = getAuth();
  const { fileId, maxBytes } = getInput.parse(args);
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

    // 직원별 Slack 채널 scope: 이 파일이 보이는 대화가 전부 권한 밖이면 거부.
    if (!fileInScope(f, channelScope)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[forbidden] 파일 '${fileId}' 은 현재 직원 권한으로 접근 불가입니다 (허용 채널 밖).`,
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
              note: '바이너리 파일 — 본문 미포함. downloadUrl 은 Authorization: Bearer <SLACK token> 헤더로 받아야 함.',
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
