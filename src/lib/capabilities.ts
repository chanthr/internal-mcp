/**
 * Tool capability gating — expose only the tool groups whose credentials (env) are present.
 *
 * Why: exposing a tool without its token makes the client attempt it and hit a runtime error.
 * Dropping it from the list up front means the LLM never tries it. Upstream (github_/railway_ remote)
 * is gated separately by connection success.
 */
import { slackUserToken, slackBotToken } from '../integrations/slack.js';

const has = (v: string | undefined): boolean => !!v && v.trim().length > 0;

/** Drive tools (search_drive / read_drive_file / list_drive_folder). Matches integrations/drive.ts. */
export function driveConfigured(): boolean {
  if (has(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)) return true;
  if (has(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.DRIVE_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.DRIVE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN;
  return has(id) && has(secret) && has(refresh);
}

/** semantic_search_drive — needs both Qdrant (vectors) and OpenAI (embeddings). */
export function semanticConfigured(): boolean {
  return has(process.env.QDRANT_URL) && has(process.env.OPENAI_API_KEY);
}

/**
 * Slack read tools (list/read channel, files) — need a bot token (xoxb). Matches integrations/slack.ts.
 * A user token never stands in for the bot: that would widen "what the bot can see" to the token owner's DMs.
 */
export function slackConfigured(): boolean {
  return has(slackBotToken());
}

/** slack_search — needs a user token (search API) AND a bot token (results are limited to bot-member channels). */
export function slackSearchConfigured(): boolean {
  return has(slackUserToken()) && has(slackBotToken());
}

/** repo_tree — GitHub token. Matches tools/repo_tree.ts. */
export function githubConfigured(): boolean {
  return has(process.env.GITHUB_TOKEN) || has(process.env.GITHUB_PAT);
}

/** railway_* (direct GraphQL). Matches tools/railway.ts. */
export function railwayConfigured(): boolean {
  return has(process.env.RAILWAY_TOKEN) || has(process.env.RAILWAY_MCP_TOKEN);
}

/** One-line boot log summary. */
export function capabilitySummary(): string {
  return [
    `drive=${driveConfigured() ? 'on' : 'off'}`,
    `semantic=${semanticConfigured() ? 'on' : 'off'}`,
    `slack=${slackConfigured() ? (slackSearchConfigured() ? 'on' : 'on(no-search)') : 'off'}`,
    `github=${githubConfigured() ? 'on' : 'off'}`,
    `railway=${railwayConfigured() ? 'on' : 'off'}`,
  ].join(' ');
}
