/**
 * slack_find_files / slack_get_file: Slack file search and download (read-only).
 *
 * - slack_find_files: with a query uses search.files (User token), without one uses files.list (Bot token, filters).
 * - slack_get_file:   files.info metadata, plus the content download when it is a text file.
 * Permission group: slack. Channel scope comes from app_users.allowed_slack_channels.
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

/** IDs of every conversation the file is shared in (public channels + private groups + DMs). For the user channel scope check. */
function fileConversationIds(f: SlackFile): string[] {
  return [...(f.channels ?? []), ...(f.groups ?? []), ...(f.ims ?? [])];
}

/**
 * Whether this file is visible within the user's channel scope. scope=null (admin or unset) = allow all.
 * Conservative (over-deny): if none of the conversations the file is shared in overlap the scope, it is not shown to a
 * restricted user.
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

  // A user with a restricted channel scope who explicitly filters by a channel outside it is rejected (same as slack_read_channel).
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
      // search.files runs with User token (xoxp) permissions, so it sees files in the token owner's DMs and private channels.
      // Exposed surface = "files shared in channels the bot is a member of" (same trust boundary as slack_search).
      //   - Files shared in private channels are listed in file.groups. The earlier channels>0
      //     filter dropped all of them, so file search returned practically 0 results.
      //   - DM-only files (ims): a D… id that is not in conversations.list → absent from botMemberIds → excluded naturally.
      //   - Files in private channels the bot was not invited to: not permitted → excluded.
      // files.list (bot token) mode only sees conversations the bot was invited to, so this limit applies automatically.
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
      // files.list also returns files from DMs sent to the bot. Filter with the same boundary as search mode (files shared in
      // channels the bot is a member of).
      const botMemberIds = await loadBotMemberChannelIds();
      files = (res.files ?? []).filter((f) => fileConversationIds(f).some((id) => botMemberIds.has(id)));
    }

    // Per-user Slack channel scope filter (admin or unset = all). Removes files from conversations outside the scope.
    const visible = files.filter((f) => fileInScope(f, channelScope));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // The number of filtered-out items is not returned (same reason slack_search omits total).
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

    // Trust boundary: only files shared in channels the bot is a member of (blocks DM-only files, same as find_files).
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

    // Per-user Slack channel scope: reject if every conversation this file is visible in is outside the user's permissions.
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

    // Binary: metadata + download URL (with a note that Bearer auth is required)
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
