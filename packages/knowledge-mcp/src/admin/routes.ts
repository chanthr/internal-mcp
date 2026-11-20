/**
 * The local console: a page in the browser for everything the setup commands do, served by the server itself.
 *
 *   /console/           the page (static files built from ../../console)
 *   /console/api/…      what the page calls
 *
 * The API adds no new way to change anything. Each write goes through the function the matching setup command
 * uses (the same live checks, the same files: .env for secrets, mcp.config.json for the rest), and then asks the
 * supervisor to start the server again so the change is in effect. Secrets go in and never come back out: the page
 * is told that a value is set, not what it is.
 *
 * Who may call it is decided in auth.ts: a browser on this machine that holds the console token.
 */
import { deleteChat, historyOf, listChats, newChat, readChat, writeChat, type StoredTurn } from './chats.js';
import { autoView, maybeRunWiki, setAuto } from '../plugins/knowledge/wiki_auto.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { configSource, getConfig, settingsDir } from '../core/config.js';
import { authStore, CONSOLE_EMAIL } from '../core/context.js';
import { logToolCall } from '../store/tool_log.js';
import type { AuthContext } from '../core/auth.js';
import { cli, stdioEntry } from '../core/invocation.js';
import { addToClient, CLIENT_IDS, describeClients, type Entry } from './clients.js';
import { getStore } from '../store/index.js';
import type { Registry } from '../plugin/registry.js';
import { isOAuthConfigured, OAUTH_ISSUER_URL, oauthGoogleProblems, oauthSignIns } from '../core/oauth.js';
import { CALLBACK_PATH, chatgptView, finishChatgptSignIn, signOutChatgpt, startChatgptSignIn } from '../core/chatgpt.js';
import { checkOcr, ocrIsLocal, ocrPrompt, ocrSettings, type OcrSettings } from '../plugins/drive/ocr.js';
import { ocrRun, ocrWaiting, startOcrRun, stopOcrRun } from '../plugins/knowledge/ocr_run.js';
import { ollamaModels, pullOllamaModel, pullState } from './ollama.js';
import { pingTool } from '../plugin/ping.js';
import { VERSION } from '../version.js';
import { checkConnection, sqlAdapterFor } from '../connections/index.js';
import { ConnectionsSchema, DataToolSchema, DataToolsSchema, dataConfigProblems, envRefs, stringsIn, type ConnectionConfig } from '../connections/schema.js';
import { embeddingsConfigured, EMBEDDING_DIM, EMBEDDING_MODEL } from '../plugins/drive/embeddings.js';
import { reembed } from '../plugins/knowledge/reembed.js';
import { folderLeftOut, folderReading, LOCAL_PREFIX, localFolders, scanFoldersSoon } from '../plugins/knowledge/folders.js';
import { getGraph, unlinked, type Graph, type GraphEdge, type GraphNode } from '../plugins/knowledge/graph.js';
import { MAX_FILE_BYTES } from '../plugins/drive/settings.js';
import { saveUpload, UPLOADS, uploadsDir } from './uploads.js';
import { checkLlm, listLlmModels, llmConfigured, llmSettings, type LlmKind } from '../core/llm.js';
import { converse, type ChatEvent, type ChatTool } from '../core/llm_chat.js';
import { createWiki, startWikiRun, stopWikiRun, WIKI, wikiDir, wikiExists, wikiStatus } from '../plugins/knowledge/wiki.js';
import { canPickFolder, pickFolder } from './folder_picker.js';
import { EXCLUDED_FOLDER_NAMES } from '../plugins/drive/exclude.js';
import { openInBrowser } from './launch.js';
import { checkAddress, recheckTunnel, signOutCloudflare, startNamedTunnel, startQuickTunnel, stopTunnel, tunnelView } from './tunnel.js';
import { cancelCliRun, CLI_ACTIONS, CLI_TOOLS, cliRun, installPlan, startCliRun, type CliAction, type CliTool } from './cli_runs.js';
import { DRIVE_COLLECTION, getLocalIndex, vectorForm, vectorProblem } from '../plugins/drive/qdrant.js';
import { cutMark, indexProfile, knownPrefixes, LEGACY_CUT } from '../plugins/drive/index_profile.js';
import { measureView, startMeasure, stopMeasure, WAYS } from '../plugins/knowledge/measure.js';
import { isTrusted, trustEntryFor, validTrustEntry } from '../plugins/drive/trust.js';
import { checkDriveCredentials, checkEmbedding, listEmbeddingModels, checkGithub, checkPostgresUrl, checkRailway, checkSlack, checkSqliteFile } from '../setup/checks.js';
import { addTrusted, BUILT_IN, configuredFolders, readConfigFile, refuseLiteralSecrets, runSetupCommand, trustedList } from '../setup/commands.js';
import { readEnvKeys, readEnvValues, updateEnvFile } from '../setup/envfile.js';
import { countDocuments } from '../setup/wizard.js';
import { backgroundExec, createDriveServiceAccount, gcloudAccount } from '../setup/auto.js';
import { railwayAuth, railwaySignedIn, readRailwayLogin, railwayReadsLogs } from '../plugins/railway/login.js';
import { consoleEnabled, consoleToken, localOnly, tokenRequired, foreignPage } from './auth.js';
import {
  completeLogin,
  driveFolderIds,
  driveUsesLogin,
  finishLogin,
  gcloudState,
  ghLogin,
  githubEndpoint,
  loginWaiting,
  parseGoogleClient,
  readGoogleLogin,
  signOutGoogle,
  signOutRailway,
  startGoogleLogin,
  startMcpLogin,
  startRailwayLogin,
} from './logins.js';
import { mcpTarget, needsSignIn, prefixOf, removeUpstream, signOutMcp, tokenEnvOf, toolsFound, upsertUpstream, upstreamEntries, sameOwner } from './upstreams.js';
import { probeUpstream } from '../core/upstream.js';
import { readUpstreamLogin, UPSTREAM_NAME, upstreamSignedIn } from '../core/upstream_login.js';
import { canReload, requestReload } from './supervisor.js';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export { settingsDir };

/** Can the console write the config? Not when it comes from an env var (MCP_CONFIG_JSON): there is no file to edit. */
const editable = () => !configSource().startsWith('env:');

/** Where the built page is: next to the compiled code, or in dist when the server runs from source. */
function uiDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [resolve(here, '../console-ui'), resolve(here, '../../dist/console-ui')]) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** The console address with its token in the fragment (never sent to a server, never logged by one). */
export function consoleUrl(port: number): string {
  return `http://localhost:${port}/console/#token=${consoleToken()}`;
}

/**
 * An address that opens the console once, for the moment after start when the server opens the browser itself.
 * The opener's command line can be read by any user of the machine, so it must not hold the token. This code is
 * good for one request within two minutes of start, and that request is answered with the real address.
 */
let _open: { code: string; until: number } | null = null;
export function consoleOpenUrl(port: number): string {
  _open = { code: randomBytes(24).toString('base64url'), until: Date.now() + 120_000 };
  return `http://localhost:${port}/console/open?code=${_open.code}`;
}
function redeemOpenCode(given: string): boolean {
  const open = _open;
  if (!open || Date.now() > open.until) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(open.code);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  _open = null; // once
  return true;
}

/** The one job the console starts that outlives its request: new vectors for the whole index. */
let vectorJob: { running: boolean; done: number; total: number; error: string | null } | null = null;

const SERVICE_ENV: Record<string, string[]> = {
  drive: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
  slack: ['SLACK_BOT_TOKEN'],
  github: ['GITHUB_PAT', 'GITHUB_TOKEN'],
  railway: ['RAILWAY_TOKEN'],
  // A model the server uses for its own work (core/llm.ts).
  llm: ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'],
  // Another model for the search assistant (plugins/knowledge/agent_search.ts). Without it, the one above.
  'search-llm': ['SEARCH_LLM_PROVIDER', 'SEARCH_LLM_API_KEY', 'SEARCH_LLM_BASE_URL', 'SEARCH_LLM_MODEL'],
  // Reading scanned documents (plugins/drive/ocr.ts). The Mathpix keys go with it: turning OCR off turns them off.
  ocr: ['OCR_PROVIDER', 'OCR_BASE_URL', 'OCR_API_KEY', 'OCR_MODEL', 'OCR_PROMPT', 'OCR_AUTO', 'MATHPIX_APP_ID', 'MATHPIX_APP_KEY'],
};
const isSet = (names: string[]) => names.some((n) => !!process.env[n]?.trim());

/** How Drive is connected: a key (service account) or a sign-in, and for a sign-in who it is and which folders are read. */
/** The OCR that is set, for the page. Keys are never sent back. */
function ocrView(): { set: boolean; kind: 'model' | 'mathpix' | null; model: string | null; baseUrl: string | null; local: boolean; keySet: boolean; auto: boolean } {
  const s = ocrSettings();
  return {
    set: !!s,
    kind: s?.kind ?? null,
    model: s?.kind === 'model' ? s.model ?? null : s ? 'Mathpix' : null,
    baseUrl: s?.baseUrl ?? null,
    local: ocrIsLocal(s),
    keySet: !!process.env.OCR_API_KEY?.trim(),
    auto: process.env.OCR_AUTO?.trim() === 'true' && ocrIsLocal(s),
  };
}

function driveVia(dir: string): { via: 'key' | 'login' | null; account: string | null; reads: string[] } {
  if (!isSet(SERVICE_ENV.drive)) return { via: null, account: null, reads: [] };
  if (!driveUsesLogin(dir)) return { via: 'key', account: null, reads: [] };
  const login = readGoogleLogin();
  const mine = new Set(login?.roots ?? []);
  let roots: Array<{ id?: string; name?: string }> = [];
  try {
    const list: unknown = readConfigFile(dir).drive?.roots;
    if (Array.isArray(list)) roots = list;
  } catch {
    /* a config file that cannot be read is reported elsewhere */
  }
  return { via: 'login', account: login?.account ?? null, reads: roots.filter((r) => mine.has(String(r?.id))).map((r) => String(r.name ?? r.id)) };
}

/** Other services' MCP servers in mcp.config.json, each with what the gateway says about it right now. */
function upstreamViews(dir: string, registry: Registry) {
  const live = new Map(registry.upstreams.statuses().map((s) => [s.name, s]));
  let entries: ReturnType<typeof upstreamEntries> = [];
  try {
    entries = upstreamEntries(dir);
  } catch {
    /* a config file that cannot be read is reported elsewhere */
  }
  return entries.map((e) => {
    const s = live.get(e.name);
    return {
      name: e.name,
      url: e.url,
      prefix: prefixOf(e),
      expose: Array.isArray(e.expose) ? ('list' as const) : e.expose ?? ('read' as const),
      via: e.signIn ? ('login' as const) : e.tokenEnv ? ('token' as const) : ('open' as const),
      // A sign-in can be gone while the entry is still there (the data folder was emptied, the address changed).
      signedIn: e.signIn ? UPSTREAM_NAME.test(e.name) && upstreamSignedIn(e.name, e.url) : null,
      // Not running: saved, and waiting for the server to start again.
      running: !!s,
      connected: s?.connected ?? false,
      tools: s?.toolCount ?? 0,
      hidden: s?.hidden ?? 0,
      error: s?.error ?? null,
    };
  });
}

/** A document of the graph as the page shows it: what it is, and how many documents it links to and from. */
function nodeView(g: Graph, n: GraphNode) {
  return { id: n.id, title: n.title, path: n.path, in: g.in.get(n.id)?.length ?? 0, out: g.out.get(n.id)?.length ?? 0 };
}

/** How Railway is connected: a token in the environment wins over a sign-in. */
/** The model the server uses for its own work: which one and where, never the key. */
/** Sign-in for connectors, as the console shows it. Names only, never values. */
function connectorsView(): { on: boolean; address: string | null; google: boolean; googleMissing: string[] } {
  const on = isOAuthConfigured();
  return { on, address: on ? OAUTH_ISSUER_URL : process.env.MCP_OAUTH_ISSUER?.trim() || null, google: on && oauthSignIns().google, googleMissing: oauthGoogleProblems() };
}

/** A model that is set, for the page: the language model (LLM_) or the search assistant's own (SEARCH_LLM_). */
function llmView(prefix = 'LLM_'): { set: boolean; provider: LlmKind | null; model: string | null; baseUrl: string | null; keySet: boolean } {
  const s = llmSettings(process.env, prefix);
  const provider = process.env[`${prefix}PROVIDER`]?.trim();
  return {
    set: !!s,
    provider: s?.kind ?? (provider === 'anthropic' || provider === 'openai' || provider === 'chatgpt' ? provider : null),
    model: s?.model ?? null,
    baseUrl: s?.baseUrl ?? (process.env[`${prefix}BASE_URL`]?.trim().replace(/\/+$/, '') || null),
    keySet: !!process.env[`${prefix}API_KEY`]?.trim(),
  };
}

/** `logs`: a sign-in that asked for the access Railway shows logs to. null for a token (it reads what it was made for). */
function railwayVia(): { set: boolean; via: 'token' | 'login' | null; who: string | null; logs: boolean | null } {
  if (isSet(SERVICE_ENV.railway)) return { set: true, via: 'token', who: null, logs: null };
  if (railwaySignedIn()) return { set: true, via: 'login', who: readRailwayLogin().who ?? null, logs: railwayReadsLogs() };
  return { set: false, via: null, who: null, logs: null };
}

/** Lines of a setup command, collected instead of printed. */
async function setup(argv: string[], dir: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const code = await runSetupCommand(argv, { dir, out: (l) => lines.push(l) });
  return { ok: code === 0, lines };
}

/** The first line of a failed command without its mark, as the message for the page. */
const firstLine = (lines: string[]) => (lines.find((l) => l.startsWith('✗')) ?? lines[0] ?? 'It did not work.').replace(/^[✗✓·]\s*/, '');

function connectionView(name: string, c: ConnectionConfig, tools: number) {
  const refs = c.type === 'postgres' ? [c.urlEnv] : c.type === 'http' ? [...new Set([...Object.values(c.headers), ...Object.values(c.query)].flatMap(envRefs))] : [];
  return {
    name,
    type: c.type,
    description: c.description ?? null,
    explore: c.type === 'http' ? false : c.explore,
    // Where it points, without anything secret: a file path, a base URL, or the name of the env var.
    target: c.type === 'sqlite' ? c.path : c.type === 'http' ? c.baseUrl : c.urlEnv,
    missingEnv: refs.filter((n) => !process.env[n]?.trim()),
    tools,
  };
}

/** Every place in a declared request where a `${NAME}` could be written. */
const toolStrings = (tool: { request?: unknown }): string[] => stringsIn(tool.request ?? {});

/** Credentials and settings of the server itself. A connection has no business sending these anywhere. */
const SERVER_OWN = new Set([
  'SLACK_BOT_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_TOKEN', 'GITHUB_PAT', 'GITHUB_TOKEN', 'RAILWAY_TOKEN', 'RAILWAY_MCP_TOKEN',
  'OPENAI_API_KEY', 'EMBEDDING_API_KEY', 'QDRANT_API_KEY', 'MATHPIX_APP_ID', 'MATHPIX_APP_KEY', 'OCR_API_KEY', 'LLM_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
  'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'MCP_API_KEY', 'MCP_CONFIG_JSON',
]);
/** …and the connection string of a database, which the console files under <NAME>_DATABASE_URL. */
const serverOwn = (name: string) => SERVER_OWN.has(name.toUpperCase()) || /_DATABASE_URL$/i.test(name) || /_MCP_TOKEN$/i.test(name);

/**
 * Why a `${NAME}` written in the console is refused, or null.
 *
 * At call time a `${NAME}` is filled from the server's whole environment, and a connection sends it to an address
 * its author chose. So what the console accepts is narrow: a name that is in this folder's .env (somebody put it
 * there for this server), or one that is not set yet. Never one of the server's own credentials, and never a
 * variable the server merely inherited from the shell it was started in (a cloud key, say).
 */
function foreignEnvProblem(dir: string, values: string[]): string | null {
  const inFile = readEnvKeys(join(dir, '.env'));
  for (const name of new Set(values.flatMap(envRefs))) {
    if (serverOwn(name)) return `\${${name}} is one of the server's own settings. A connection cannot send it to another service.`;
    if (process.env[name]?.trim() && !inFile.has(name)) {
      return `\${${name}} is set in the environment the server was started from, not in .env. A connection made here uses secrets from .env only. Put it there with: ${cli(`setup secret ${name}`)}`;
    }
  }
  return null;
}

/** Is there a desktop to open a browser on? macOS and Windows have one; Linux has one when a display is set. */
const consoleOpens = (): boolean => process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** On every answer of the console (see mountConsole). The page looks for it. */
export const CONSOLE_HEADER = 'X-Knowledge-MCP-Console';

export function mountConsole(app: Express, registry: Registry): boolean {
  if (!consoleEnabled()) return false;
  const ui = uiDir();
  const api = express.Router();
  api.use(tokenRequired);

  /** Run a change, answer, and start the server again when something supervises it. */
  const change = (res: Response, result: Record<string, unknown> = {}) => {
    const restarting = requestReload();
    res.json({ ok: true, ...result, restarting, restartNeeded: !restarting });
  };
  const refuse = (res: Response, status: number, error: string) => void res.status(status).json({ error });
  const mustEdit = (res: Response): boolean => {
    if (editable()) return true;
    refuse(res, 409, 'The settings come from the MCP_CONFIG_JSON env var, so there is no file to change. Edit that variable, or move the settings to mcp.config.json.');
    return false;
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      if (!res.headersSent) refuse(res, e instanceof z.ZodError ? 400 : 422, e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : msg(e));
    });
  };

  // What a form field may hold. A token, a URL and a model name are one line of visible characters; a path may
  // hold spaces. Nothing typed into the console holds a line break or another control character.
  const visible = (max: number) => z.string().trim().max(max).regex(/^[\x21-\x7e]*$/, 'no spaces, line breaks or other invisible characters');
  const secret = visible(500).min(10);
  const oneLine = (max: number) => z.string().trim().max(max).regex(/^[^\0-\x1f\x7f]*$/, 'no line breaks or other control characters');
  const webUrl = (max: number) =>
    visible(max).refine((v) => {
      try {
        return /^https?:$/.test(new URL(v).protocol);
      } catch {
        return false;
      }
    }, 'a full address that starts with http:// or https://');

  const modelName = visible(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'a model name');
  /**
   * The embedding key that is already saved, for the endpoint it was saved for and no other: a key is never sent
   * to an address it was not given for.
   */
  const savedEmbeddingKey = (baseUrl: string | undefined): string | undefined => {
    const savedBase = process.env.EMBEDDING_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
    if (!baseUrl) return process.env.OPENAI_API_KEY?.trim() || (savedBase ? undefined : process.env.EMBEDDING_API_KEY?.trim()) || undefined;
    return baseUrl === savedBase ? process.env.EMBEDDING_API_KEY?.trim() || undefined : undefined;
  };

  // A model for the server's own work (core/llm.ts): what the page sends to list a provider's models and to save.
  // `for`: the language model (llm), or the search assistant's own (search-llm).
  const llmBody = z.object({
    provider: z.enum(['anthropic', 'openai', 'chatgpt']),
    baseUrl: webUrl(500).optional().or(z.literal('')),
    apiKey: visible(500).optional(),
    for: z.enum(['llm', 'search-llm']).optional(),
  });
  const llmPrefixOf = (id: 'llm' | 'search-llm' | undefined) => (id === 'search-llm' ? 'SEARCH_LLM_' : 'LLM_');
  /** The key saved under `prefix`, when it was saved for this provider and address. */
  const savedKeyFor = (prefix: string, kind: LlmKind, baseUrl: string | undefined): string | undefined => {
    const same = process.env[`${prefix}PROVIDER`]?.trim() === kind && (kind === 'anthropic' || process.env[`${prefix}BASE_URL`]?.trim().replace(/\/+$/, '') === baseUrl);
    return same ? process.env[`${prefix}API_KEY`]?.trim() || undefined : undefined;
  };
  /**
   * The connection the page describes. A key that is already saved is used for the provider and address it was
   * saved for and for no other: a key is never sent to an address it was not given for. The search assistant on
   * the language model's provider and address uses the language model's key.
   */
  const llmFrom = (body: z.infer<typeof llmBody>, prefix: string): { kind: LlmKind; baseUrl?: string; apiKey?: string } => {
    const kind = body.provider;
    // A ChatGPT plan is used through its sign-in (core/chatgpt.ts): no address, no key.
    if (kind === 'chatgpt') return { kind };
    const baseUrl = kind === 'openai' ? body.baseUrl?.replace(/\/+$/, '') || undefined : undefined;
    if (kind === 'openai' && !baseUrl) throw new Error('The address of the API is needed (it usually ends in /v1).');
    const apiKey = body.apiKey || savedKeyFor(prefix, kind, baseUrl) || (prefix !== 'LLM_' ? savedKeyFor('LLM_', kind, baseUrl) : undefined);
    if (kind === 'anthropic' && !apiKey) throw new Error('Claude needs an API key.');
    return { kind, baseUrl, apiKey };
  };

  // ── What is set up ──
  api.get(
    '/state',
    wrap(async (_req, res) => {
      const dir = settingsDir();
      const cfg = getConfig();
      const store = await getStore();
      const local = await getLocalIndex().catch(() => null);
      let index: Record<string, unknown> | null = null;
      if (local) {
        const s = await local.stats(DRIVE_COLLECTION);
        const problem = embeddingsConfigured() ? await vectorProblem() : null;
        const made = await local.embeddingState(DRIVE_COLLECTION);
        // `problem` is a sentence for the terminal. The page says it in its own words from these two facts.
        const profile = indexProfile();
        index = {
          ...s,
          meaning: embeddingsConfigured() && !problem,
          problem,
          vectorsFrom: made && made.vectors > 0 ? made.model ?? 'another model' : null,
          job: vectorJob,
          // How passages are made (index_profile.ts), and how much of the index is not made that way yet.
          profile: {
            cut: profile.cut,
            maxTokens: profile.maxTokens,
            overlapTokens: profile.overlapTokens,
            header: profile.header,
            queryPrefix: profile.queryPrefix,
            passagePrefix: profile.passagePrefix,
            prefixFrom: profile.prefixFrom,
            // The prefixes the model was trained with, when it is one this knows: offered even when set by hand.
            modelPrefixes: embeddingsConfigured() ? knownPrefixes() : null,
          },
          recut: await local.documentsCutOtherwise(DRIVE_COLLECTION, cutMark(profile), LEGACY_CUT),
          behind: embeddingsConfigured() && !problem ? (await vectorForm()).behind : false,
        };
      }
      const tools = registry
        .listTools(pingTool)
        .filter((t) => t.name !== pingTool.name) // answered by the transport itself; nothing to try
        .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        group: registry.groupOf(t.name),
        readOnly: t.annotations?.readOnlyHint !== false,
        inputSchema: t.inputSchema,
        declared: cfg.tools.some((d) => d.name === t.name),
      }));
      res.json({
        version: VERSION,
        dir,
        editable: editable(),
        canRestart: canReload(),
        store: { kind: store.kind, location: store.location },
        index,
        plugins: registry.status(),
        // Counted in the index (what can be searched), not by walking the folder on every status read.
        folders: await Promise.all(
          configuredFolders(dir).map(async (f) => {
            const known = localFolders().find((k) => k.path === f.path);
            const documents = !existsSync(f.path) ? null : local && known ? await local.countDocuments(DRIVE_COLLECTION, `${LOCAL_PREFIX}${known.name}/`) : countDocuments(f.path);
            // While the folder is being read the count is of what was read so far: the page says so, and which
            // files it could not read when it is done. A few names are enough to find the rest.
            const left = known ? folderLeftOut(known.name) : { noText: [], failed: [] };
            const some = (names: string[]) => ({ count: names.length, names: names.slice(0, 3) });
            return { path: f.path, name: f.name ?? null, documents, reading: known ? folderReading(known.name) : null, noText: some(left.noText), failed: some(left.failed) };
          }),
        ),
        // The computer's folder chooser can be opened from the page (folder_picker.ts).
        folderPicker: await canPickFolder(),
        // Folder names never indexed (node_modules, …): the page leaves them out of an upload instead of sending them.
        excludedFolders: [...EXCLUDED_FOLDER_NAMES],
        services: {
          drive: { set: isSet(SERVICE_ENV.drive), trusted: trustedList({ dir }), ...driveVia(dir) },
          slack: { set: isSet(SERVICE_ENV.slack) },
          github: { set: isSet(SERVICE_ENV.github) },
          railway: railwayVia(),
          llm: llmView(),
          searchLlm: llmView('SEARCH_LLM_'),
          ocr: ocrView(),
          embeddings: {
            set: embeddingsConfigured(),
            model: embeddingsConfigured() ? EMBEDDING_MODEL : null,
            dim: embeddingsConfigured() ? EMBEDDING_DIM : null,
            baseUrl: process.env.EMBEDDING_BASE_URL?.trim() || null,
            keySet: !!(process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()),
          },
        },
        connections: Object.entries(cfg.connections).map(([name, c]) => connectionView(name, c, cfg.tools.filter((t) => t.connection === name).length)),
        declaredTools: cfg.tools,
        tools,
        // Other services' MCP servers in the list, and how each one is doing right now.
        upstreams: upstreamViews(dir, registry),
        // A sign-in that came back from another site and waits to be saved: the page saves it when it sees this.
        login: loginWaiting(),
        // Sign-in for connectors (Claude, ChatGPT): on with a public address and a signing secret (core/oauth.ts).
        connectors: connectorsView(),
      });
    }),
  );

  // Every configured service checked live, as `setup check` prints it.
  api.get(
    '/check',
    wrap(async (_req, res) => {
      const { lines } = await setup(['check'], settingsDir());
      res.json({
        lines: lines
          .filter((l) => /^[✓✗·]/.test(l))
          .map((l) => {
            const m = /^([✓✗·])\s+(.+?)\s{2,}(.*)$/.exec(l) ?? /^([✓✗·])\s+(\S+)\s+(.*)$/.exec(l);
            return m ? { ok: m[1] === '✓' ? true : m[1] === '✗' ? false : null, what: m[2].trim(), text: m[3] } : { ok: null, what: '', text: l };
          }),
      });
    }),
  );

  // ── Documents on this machine ──
  /**
   * Open the computer's folder chooser and add the folder that is picked, where it is (folder_picker.ts). Waits
   * while the person chooses. Nothing is added when they close the chooser.
   */
  api.post(
    '/folders/choose',
    wrap(async (_req, res) => {
      if (!mustEdit(res)) return;
      const picked = await pickFolder();
      if ('canceled' in picked) return void res.json({ canceled: true });
      const r = await setup(['folder', picked.path], settingsDir());
      if (!r.ok) return refuse(res, 422, firstLine(r.lines));
      change(res, { path: picked.path });
    }),
  );
  api.post(
    '/folders',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { path } = z.object({ path: oneLine(1000).min(1) }).parse(req.body);
      const full = resolve(settingsDir(), path.trim().replace(/^~(?=$|\/)/, homedir()));
      const r = await setup(['folder', full], settingsDir());
      if (!r.ok) return refuse(res, 422, firstLine(r.lines));
      change(res, { path: full });
    }),
  );
  api.delete(
    '/folders',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
      const dir = settingsDir();
      const config = readConfigFile(dir);
      const before: Array<{ path: string }> = Array.isArray(config.folders) ? config.folders : [];
      config.folders = before.filter((f) => resolve(dir, f.path) !== resolve(dir, path));
      if (config.folders.length === before.length) return refuse(res, 404, 'That folder is not in the list.');
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      change(res);
    }),
  );

  // ── Files dropped on the page (uploads.ts) ──
  api.put(
    '/uploads',
    // Read after the token was checked: a request without it is turned away before its body is taken in.
    express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES }),
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const path = z.string().min(1).max(1000).parse(req.query.path);
      if (!Buffer.isBuffer(req.body)) return refuse(res, 400, 'Send the file as the body of the request (application/octet-stream).');
      res.json({ ok: true, ...(await saveUpload(settingsDir(), path, req.body)) });
    }),
  );
  api.post(
    '/uploads/done',
    wrap(async (_req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const full = uploadsDir(dir);
      if (!existsSync(full)) return refuse(res, 409, 'Nothing has been uploaded yet.');
      // The first upload makes `uploads/` a folder of this server, like any folder that is added.
      if (!configuredFolders(dir).some((f) => f.path === full)) {
        const r = await setup(['folder', full, '--name', UPLOADS], dir);
        if (!r.ok) return refuse(res, 422, firstLine(r.lines));
        return change(res, { note: 'The files are in. The server is reading them now.' });
      }
      // The running server knows the folder: read the new files now rather than at the next timed scan. The answer
      // does not wait for it: a folder of PDFs takes a while, and the page shows how far the reading is.
      if (localFolders().some((f) => f.path === full)) {
        void scanFoldersSoon().catch(() => undefined); // the timed pass reads them if this one fails
        return void res.json({ ok: true, restarting: false, restartNeeded: false, note: 'The files are in. The server is reading them now.' });
      }
      change(res);
    }),
  );
  // ── Reaching the server from outside through a Cloudflare Tunnel (tunnel.ts) ──
  api.get('/tunnel', wrap(async (_req, res) => void res.json(await tunnelView())));
  api.post(
    '/tunnel',
    wrap(async (req, res) => {
      const body = z.discriminatedUnion('mode', [z.object({ mode: z.literal('quick') }), z.object({ mode: z.literal('named'), hostname: visible(253).min(4) })]).parse(req.body);
      const port = req.socket.localPort ?? 0;
      res.json(body.mode === 'quick' ? await startQuickTunnel(port) : await startNamedTunnel(port, body.hostname));
    }),
  );
  api.delete(
    '/tunnel',
    wrap(async (_req, res) => {
      stopTunnel();
      res.json(await tunnelView());
    }),
  );
  // Before an address of one's own: is its domain on Cloudflare, and is this server signed in for it? Reads only.
  api.post(
    '/tunnel/check',
    wrap(async (req, res) => {
      const { hostname } = z.object({ hostname: visible(253).min(4) }).strict().parse(req.body);
      res.json(await checkAddress(hostname));
    }),
  );
  api.post('/tunnel/recheck', wrap(async (_req, res) => void res.json(await recheckTunnel())));
  // Forget this server's Cloudflare sign-in, to sign in for another domain. A running tunnel keeps running.
  api.delete(
    '/tunnel/sign-in',
    wrap(async (_req, res) => {
      signOutCloudflare();
      res.json(await tunnelView());
    }),
  );

  // ── Reading scanned documents (plugins/drive/ocr.ts, plugins/knowledge/ocr_run.ts) ──
  api.get(
    '/ocr',
    wrap(async (_req, res) => {
      const s = ocrSettings();
      // The models Ollama has on this computer, when the OCR is (or would be) Ollama here.
      const base = s?.kind === 'model' && s.baseUrl ? s.baseUrl : 'http://localhost:11434/v1';
      res.json({ waiting: ocrWaiting(), run: ocrRun(), installed: await ollamaModels(base), pull: pullState() });
    }),
  );
  api.post(
    '/ocr/run',
    wrap(async (req, res) => {
      const { limit } = z.object({ limit: z.number().int().min(1).max(100_000).optional() }).strict().parse(req.body ?? {});
      res.json(startOcrRun({ limit }));
    }),
  );
  api.post(
    '/ocr/stop',
    wrap(async (_req, res) => {
      stopOcrRun();
      res.json(ocrRun());
    }),
  );
  api.post(
    '/ocr/auto',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { on } = z.object({ on: z.boolean() }).strict().parse(req.body);
      if (on && !ocrIsLocal()) return refuse(res, 422, 'Reading every new scan by itself is offered only for an OCR on this computer.');
      updateEnvFile(join(settingsDir(), '.env'), { OCR_AUTO: on ? 'true' : undefined });
      change(res);
    }),
  );
  api.post(
    '/ocr/pull',
    wrap(async (req, res) => {
      const body = z.object({ model: modelName, baseUrl: webUrl(500).optional() }).strict().parse(req.body);
      res.json(pullOllamaModel(body.baseUrl ?? 'http://localhost:11434/v1', body.model));
    }),
  );

  // ── A wiki written from the documents by the connected model (plugins/knowledge/wiki.ts) ──
  api.get('/wiki', wrap(async (_req, res) => void res.json({ ...(await wikiStatus(settingsDir())), model: llmConfigured(), auto: autoView() })));
  // Keep the wiki up to date by itself (plugins/knowledge/wiki_auto.ts): on reads what is added or changed from now.
  api.post(
    '/wiki/auto',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { on, perDay } = z.object({ on: z.boolean(), perDay: z.number().int().min(1).max(500).optional() }).strict().parse(req.body);
      if (on && !wikiExists(settingsDir())) return refuse(res, 409, 'There is no wiki yet. Create it first.');
      const view = await setAuto(on, perDay, settingsDir());
      // Turned on: whatever came since the last pass is looked at now, not at the next pass.
      if (on) void maybeRunWiki(settingsDir()).catch(() => undefined);
      res.json(view);
    }),
  );
  api.post(
    '/wiki',
    wrap(async (_req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const root = createWiki(dir);
      // The wiki is a folder of this server like any other: searched, read and linked.
      if (configuredFolders(dir).some((f) => f.path === root)) return void res.json({ ok: true, restarting: false, restartNeeded: false });
      const r = await setup(['folder', root, '--name', WIKI], dir);
      if (!r.ok) return refuse(res, 422, firstLine(r.lines));
      change(res, { note: 'The wiki folder is made. Read your documents into it from the Wiki page.' });
    }),
  );
  api.post(
    '/wiki/run',
    wrap(async (req, res) => {
      const dir = settingsDir();
      const { limit } = z.object({ limit: z.number().int().min(1).max(500).default(25) }).parse(req.body ?? {});
      if (!wikiExists(dir)) return refuse(res, 409, 'There is no wiki yet. Create it first.');
      if (!llmConfigured()) return refuse(res, 409, 'No model is connected. Connect one on this page first.');
      // The pages that were written are read into the index when the run has written them.
      res.json(startWikiRun(dir, { limit, afterWrite: () => void scanFoldersSoon().catch(() => undefined) }));
    }),
  );
  api.post(
    '/wiki/stop',
    wrap(async (_req, res) => {
      stopWikiRun();
      res.json({ ok: true });
    }),
  );
  void wikiDir;

  // ── How the documents link to each other (plugins/knowledge/graph.ts) ──
  api.get(
    '/graph',
    wrap(async (_req, res) => {
      const g = getGraph();
      const nodes = [...g.nodes.values()];
      res.json({
        documents: nodes.length,
        links: g.edges,
        unlinked: unlinked(g).length,
        broken: g.broken.length,
        top: nodes.map((n) => nodeView(g, n)).filter((v) => v.in > 0).sort((a, b) => b.in - a.in || a.title.localeCompare(b.title)).slice(0, 15),
        alone: unlinked(g).slice(0, 30).map((n) => nodeView(g, n)),
        brokenLinks: g.broken.slice(0, 50).map((b) => ({ from: nodeView(g, g.nodes.get(b.from)!), target: b.target })),
      });
    }),
  );
  api.get(
    '/graph/find',
    wrap(async (req, res) => {
      const q = z.string().max(200).parse(req.query.q ?? '').normalize('NFC').toLowerCase().trim();
      const g = getGraph();
      const hits = q ? [...g.nodes.values()].filter((n) => n.title.toLowerCase().includes(q) || n.path.normalize('NFC').toLowerCase().includes(q)) : [];
      res.json({ found: hits.slice(0, 20).map((n) => nodeView(g, n)) });
    }),
  );
  api.get(
    '/graph/node',
    wrap(async (req, res) => {
      const id = z.string().min(1).max(2000).parse(req.query.id);
      const g = getGraph();
      const node = g.nodes.get(id);
      if (!node) return refuse(res, 404, 'That document is not in the graph.');
      const ends = (edges: GraphEdge[] | undefined, end: 'to' | 'from') =>
        (edges ?? []).map((e) => ({ ...nodeView(g, g.nodes.get(e[end])!), meta: e.meta })).sort((a, b) => a.title.localeCompare(b.title));
      res.json({ node: nodeView(g, node), out: ends(g.out.get(id), 'to'), in: ends(g.in.get(id), 'from'), broken: g.broken.filter((b) => b.from === id).map((b) => b.target) });
    }),
  );

  // ── Services: a secret is checked against the real service, then saved to .env ──
  api.post(
    '/services/:id',
    wrap(async (req, res) => {
      const dir = settingsDir();
      const envPath = join(dir, '.env');
      const id = String(req.params.id);
      if (id === 'slack') {
        const { token } = z.object({ token: secret }).parse(req.body);
        const r = await checkSlack(token.trim());
        updateEnvFile(envPath, { SLACK_BOT_TOKEN: token.trim() });
        return change(res, { found: `${r.team} as ${r.user}` });
      }
      if (id === 'github') {
        const body = z.object({ token: secret.optional(), fromGh: z.literal(true).optional() }).parse(req.body);
        let token = body.token;
        if (body.fromGh) {
          // The login the gh CLI already has on this machine. The token goes from gh to .env and is never shown.
          const gh = await ghLogin();
          if (!gh.token) return refuse(res, 422, gh.installed ? 'The gh CLI is not signed in. In a terminal: gh auth login' : 'The gh CLI is not installed on this machine.');
          token = gh.token;
        }
        if (!token) return refuse(res, 400, 'token: paste a token, or use the gh login');
        const r = await checkGithub(token, { apiBase: body.fromGh ? githubEndpoint.api : undefined });
        updateEnvFile(envPath, { GITHUB_PAT: token });
        return change(res, { found: `signed in as ${r.login}` });
      }
      if (id === 'railway') {
        const { token } = z.object({ token: secret }).parse(req.body);
        const r = await checkRailway(token.trim());
        updateEnvFile(envPath, { RAILWAY_TOKEN: token.trim() });
        // A token and a sign-in are two ways to the same thing: the token is used, so the sign-in goes.
        if (railwaySignedIn()) await signOutRailway();
        return change(res, { found: r.who });
      }
      if (id === 'llm' || id === 'search-llm') {
        const prefix = llmPrefixOf(id);
        const body = llmBody.extend({ model: modelName }).parse(req.body);
        const settings = llmFrom(body, prefix);
        const r = await checkLlm({ ...settings, model: body.model });
        // The saved key stays only for the provider and address it was given for. Another provider's key is not
        // kept, so that it is never sent to this one (a ChatGPT plan has none at all).
        const keep = settings.kind !== 'chatgpt' && savedKeyFor(prefix, settings.kind, settings.baseUrl) !== undefined;
        updateEnvFile(envPath, {
          [`${prefix}PROVIDER`]: settings.kind,
          [`${prefix}BASE_URL`]: settings.kind === 'openai' ? settings.baseUrl : undefined,
          [`${prefix}MODEL`]: r.model,
          ...(body.apiKey ? { [`${prefix}API_KEY`]: body.apiKey } : keep ? {} : { [`${prefix}API_KEY`]: undefined }),
        });
        return change(res, { found: `${r.model} answered` });
      }
      if (id === 'ocr') {
        const body = z
          .discriminatedUnion('provider', [
            z.object({ provider: z.literal('model'), baseUrl: webUrl(500), model: modelName, apiKey: visible(500).optional(), auto: z.boolean().optional() }).strict(),
            z.object({ provider: z.literal('mathpix'), appId: visible(200).min(2), appKey: secret }).strict(),
          ])
          .parse(req.body);
        if (body.provider === 'mathpix') {
          updateEnvFile(envPath, { OCR_PROVIDER: 'mathpix', OCR_BASE_URL: undefined, OCR_MODEL: undefined, OCR_API_KEY: undefined, OCR_PROMPT: undefined, MATHPIX_APP_ID: body.appId, MATHPIX_APP_KEY: body.appKey });
          return change(res, { found: 'Mathpix' });
        }
        const baseUrl = body.baseUrl.replace(/\/+$/, '');
        // A key already saved is used again only for the address it was saved for.
        const saved = process.env.OCR_BASE_URL?.replace(/\/+$/, '') === baseUrl ? process.env.OCR_API_KEY?.trim() || undefined : undefined;
        const s: OcrSettings = { kind: 'model', baseUrl, model: body.model, apiKey: body.apiKey || saved, prompt: ocrPrompt(body.model) };
        const r = await checkOcr(s);
        updateEnvFile(envPath, {
          OCR_PROVIDER: 'model',
          OCR_BASE_URL: baseUrl,
          OCR_MODEL: body.model,
          ...(body.apiKey ? { OCR_API_KEY: body.apiKey } : saved ? {} : { OCR_API_KEY: undefined }),
          OCR_AUTO: body.auto && ocrIsLocal(s) ? 'true' : undefined,
        });
        return change(res, { found: `${body.model} read the test page in ${r.seconds} s` });
      }
      if (id === 'embeddings') {
        const body = z
          .object({ baseUrl: webUrl(500).optional().or(z.literal('')), model: modelName.optional().or(z.literal('')), apiKey: visible(500).optional() })
          .parse(req.body);
        const baseUrl = body.baseUrl?.replace(/\/+$/, '') || undefined;
        const typed = body.apiKey || undefined;
        const apiKey = typed ?? savedEmbeddingKey(baseUrl);
        if (!baseUrl && !apiKey) return refuse(res, 422, 'OpenAI needs an API key.');
        const r = await checkEmbedding({ baseUrl, model: body.model || undefined, apiKey });
        const standard = !baseUrl && r.model === 'text-embedding-3-small';
        updateEnvFile(
          envPath,
          baseUrl
            ? { EMBEDDING_BASE_URL: baseUrl, EMBEDDING_MODEL: r.model, EMBEDDING_DIM: String(r.dim), ...(typed ? { EMBEDDING_API_KEY: typed } : {}) }
            : { ...(typed ? { OPENAI_API_KEY: typed } : {}), EMBEDDING_BASE_URL: undefined, EMBEDDING_MODEL: standard ? undefined : r.model, EMBEDDING_DIM: standard ? undefined : String(r.dim) },
        );
        return change(res, { found: `${r.model} (${r.dim} dimensions)` });
      }
      if (id === 'drive' && req.body && typeof req.body === 'object' && 'gcloud' in req.body) {
        // The gcloud CLI is signed in here: it makes the service account and its key, as `setup drive --gcloud` does.
        const { gcloud } = z.object({ gcloud: z.object({ project: z.string().regex(/^[a-z][a-z0-9.:-]{4,60}$/, 'a Google Cloud project ID') }) }).parse(req.body);
        const account = await gcloudAccount(backgroundExec);
        if (!account) return refuse(res, 422, 'gcloud is not signed in. In a terminal: gcloud auth login');
        const keyPath = join(dir, 'drive-service-account.json');
        // The key this console wrote makes way for the new one. A key file somebody else put there stays, and stops this.
        if (existsSync(keyPath) && resolve(dir, readEnvValues(envPath).get('GOOGLE_APPLICATION_CREDENTIALS') ?? '.') === keyPath) rmSync(keyPath, { force: true });
        const made = await createDriveServiceAccount(backgroundExec, { project: gcloud.project, name: 'knowledge-mcp-drive', keyPath });
        if (driveUsesLogin(dir)) await signOutGoogle(dir);
        updateEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: keyPath });
        // Whoever made the account is the first owner whose shared documents are shown.
        const own = trustEntryFor(account);
        if (own && editable()) addTrusted(dir, [own]);
        return change(res, { found: made.email, email: made.email, shared: [] });
      }
      if (id === 'drive') {
        const { key } = z.object({ key: z.string().min(50).max(20_000) }).parse(req.body);
        const r = await checkDriveCredentials(key, 'the pasted key');
        const keyPath = join(dir, 'drive-service-account.json');
        writeFileSync(keyPath, key.trim().endsWith('\n') ? key.trim() : `${key.trim()}\n`, { mode: 0o600 });
        chmodSync(keyPath, 0o600);
        if (driveUsesLogin(dir)) await signOutGoogle(dir);
        updateEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: keyPath });
        const trusted = trustedList({ dir });
        return change(res, {
          found: r.email ?? 'connected',
          email: r.email,
          shared: r.shared.map((s) => ({ name: s.name, folder: s.folder, owners: s.owners, trusted: isTrusted(trusted, s.owners, s.driveId) })),
        });
      }
      refuse(res, 404, 'There is no such service.');
    }),
  );
  // ── Signing in instead of pasting a token (logins.ts) ──
  /** How the console page was opened. The other site sends the browser back to this address. */
  const origin = (req: Request) => `http://${String(req.headers.host)}`;
  api.get(
    '/logins/gh',
    wrap(async (_req, res) => {
      const gh = await ghLogin();
      // Which account it is: the person should see whose login they are about to use.
      const login = gh.token ? await checkGithub(gh.token, { apiBase: githubEndpoint.api }).then((r) => r.login, () => null) : null;
      res.json({ installed: gh.installed, login });
    }),
  );
  api.get('/logins/gcloud', wrap(async (_req, res) => void res.json(await gcloudState())));
  // A command-line tool looked after for the person at their click, instead of "go to a terminal and type …":
  // installing it, and its own sign-in (cli_runs.ts). The tool is one of two, the step one of two, and each
  // command is fixed: nothing of the request reaches a command line.
  const cliStep = (req: Request): [CliTool, CliAction] => [
    z.enum(CLI_TOOLS as [CliTool, ...CliTool[]]).parse(req.params.tool),
    z.enum(CLI_ACTIONS as [CliAction, ...CliAction[]]).parse(req.params.action),
  ];
  api.get(
    '/logins/:tool/:action',
    wrap(async (req, res) => {
      const [tool, action] = cliStep(req);
      // An install says what it would run, so the person reads it before agreeing.
      res.json({ ...cliRun(tool, action), ...(action === 'install' ? await installPlan(tool) : {}) });
    }),
  );
  api.post(
    '/logins/:tool/:action',
    wrap(async (req, res) => {
      const [tool, action] = cliStep(req);
      res.json(await startCliRun(tool, action));
    }),
  );
  api.delete(
    '/logins/:tool/:action',
    wrap(async (req, res) => {
      cancelCliRun(...cliStep(req));
      res.json({ ok: true });
    }),
  );
  api.get(
    '/logins/google',
    wrap(async (req, res) => {
      const saved = readGoogleLogin();
      res.json({ clientSaved: !!saved, account: saved?.account ?? null, redirectUri: `${origin(req)}/console/login/google` });
    }),
  );
  api.post(
    '/logins/railway',
    wrap(async (req, res) => {
      const { logs } = z.object({ logs: z.boolean().optional() }).parse(req.body ?? {});
      res.json({ url: await startRailwayLogin(origin(req), { logs }) });
    }),
  );
  api.post(
    '/logins/google',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return; // the folders to read are saved in mcp.config.json
      const body = z
        .object({ clientId: z.string().trim().max(5000).optional(), clientSecret: z.string().trim().max(300).optional(), folders: z.array(z.string().max(500)).max(20).nullable().optional() })
        .parse(req.body);
      const client = body.clientId ? parseGoogleClient(body.clientId, body.clientSecret ?? '') : undefined;
      const folders = body.folders?.some((f) => f.trim()) ? driveFolderIds(body.folders) : null;
      res.json({ url: startGoogleLogin(origin(req), { client, folders }) });
    }),
  );
  api.post(
    '/logins/finish',
    wrap(async (_req, res) => {
      const done = await finishLogin(settingsDir());
      change(res, { found: done.found, note: `${done.label} is connected: ${done.found}.` });
    }),
  );

  // ── Other services' MCP servers (upstreams.ts) ──
  /** Connect and list the tools, with what went wrong said so that the form can show it. */
  const lookAt = async (spec: Parameters<typeof probeUpstream>[0]) => {
    try {
      return await probeUpstream(spec);
    } catch (e) {
      throw new Error(`${new URL(spec.url).host} did not list its tools (${msg(e).slice(0, 200)}).`);
    }
  };
  api.post(
    '/upstreams',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const body = z.object({ name: z.string().max(40), url: z.string().max(1000), token: secret.optional() }).parse(req.body);
      // Its name is its permission group and the start of its tool names: it cannot be one that is in use.
      const taken = new Set([...BUILT_IN, ...Object.keys(getConfig().connections), ...Object.keys(readConfigFile(dir).connections ?? {}), ...registry.status().map((p) => p.id)]);
      const target = mcpTarget(dir, body, taken);
      if (body.token) {
        const seen = await lookAt({ name: target.name, url: target.url, prefix: prefixOf(target), token: body.token });
        const env = tokenEnvOf(target.name);
        updateEnvFile(join(dir, '.env'), { [env]: body.token });
        if (readUpstreamLogin(target.name)) await signOutMcp(target.name);
        upsertUpstream(dir, { name: target.name, url: target.url, tokenEnv: env });
        return change(res, { found: toolsFound(seen), note: `${target.name} is connected: ${toolsFound(seen)}.` });
      }
      // The server wants a sign-in: the page goes there, and the server is added when the sign-in is saved.
      if (await needsSignIn(target.url)) {
        const { url, at } = await startMcpLogin(origin(req), target);
        const server = new URL(target.url).host;
        // `elsewhere`: the sign-in happens at another owner's address than the server being added. The page asks
        // before it goes there, because what is allowed there is handed to the server.
        return void res.json({ signIn: url, at, server, elsewhere: !sameOwner(at, server) });
      }
      const seen = await lookAt({ name: target.name, url: target.url, prefix: prefixOf(target) });
      upsertUpstream(dir, { name: target.name, url: target.url });
      change(res, { found: toolsFound(seen), note: `${target.name} is connected: ${toolsFound(seen)}.` });
    }),
  );
  api.patch(
    '/upstreams/:name',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { expose } = z.object({ expose: z.enum(['read', 'all']) }).parse(req.body);
      const dir = settingsDir();
      const entry = upstreamEntries(dir).find((e) => e.name === String(req.params.name));
      if (!entry) return refuse(res, 404, 'That server is not in the list.');
      upsertUpstream(dir, { ...entry, expose });
      change(res);
    }),
  );
  api.delete(
    '/upstreams/:name',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const name = String(req.params.name);
      const gone = removeUpstream(dir, name);
      if (!gone) return refuse(res, 404, 'That server is not in the list.');
      // What the console made for it goes with it: the sign-in (here and at the service) and a pasted token.
      if (UPSTREAM_NAME.test(name)) await signOutMcp(name);
      if (gone.tokenEnv && gone.tokenEnv === tokenEnvOf(name)) updateEnvFile(join(dir, '.env'), { [gone.tokenEnv]: undefined });
      change(res);
    }),
  );
  api.post(
    '/llm/models',
    wrap(async (req, res) => {
      const body = llmBody.parse(req.body);
      res.json({ models: await listLlmModels(llmFrom(body, llmPrefixOf(body.for))) });
    }),
  );
  // ── Sign-in for connectors: Claude and ChatGPT add the server by its address and sign in with a key ──
  // On: the public address becomes the OAuth issuer, and a signing secret is made the first time. The address must
  // be https (a connector refuses anything else), or this machine for trying it.
  const connectorsBody = z.object({ address: webUrl(300) });
  api.post(
    '/connectors',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const u = new URL(connectorsBody.parse(req.body).address);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !local) return refuse(res, 400, 'Connectors need an https address.');
      const secret = (process.env.OAUTH_JWT_SECRET ?? '').trim();
      updateEnvFile(join(settingsDir(), '.env'), {
        MCP_OAUTH_ISSUER: u.origin,
        ...(secret.length >= 32 ? {} : { OAUTH_JWT_SECRET: randomBytes(32).toString('base64url') }),
      });
      change(res, { note: `Connectors can sign in at ${u.origin}/mcp with a key.` });
    }),
  );
  api.delete(
    '/connectors',
    wrap(async (_req, res) => {
      if (!mustEdit(res)) return;
      // The secret stays: turned on again, tokens already given out work again too. The address goes.
      updateEnvFile(join(settingsDir(), '.env'), { MCP_OAUTH_ISSUER: undefined });
      change(res);
    }),
  );
  // ── A ChatGPT plan as the model: "Continue with ChatGPT" (core/chatgpt.ts) ──
  api.get('/llm/chatgpt', wrap(async (_req, res) => void res.json(chatgptView())));
  api.post(
    '/llm/chatgpt/sign-in',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      // OpenAI sends the browser back to this server on 127.0.0.1, on the port this request came in on.
      res.json({ url: startChatgptSignIn(req.socket.localPort ?? 0) });
    }),
  );
  api.delete(
    '/llm/chatgpt',
    wrap(async (_req, res) => {
      if (!mustEdit(res)) return;
      await signOutChatgpt();
      // Signed out of the model in use: the model setting goes too, so nothing tries to use it.
      const gone = {
        ...(process.env.LLM_PROVIDER?.trim() === 'chatgpt' ? { LLM_PROVIDER: undefined, LLM_MODEL: undefined } : {}),
        ...(process.env.SEARCH_LLM_PROVIDER?.trim() === 'chatgpt' ? { SEARCH_LLM_PROVIDER: undefined, SEARCH_LLM_MODEL: undefined } : {}),
      };
      if (Object.keys(gone).length) {
        updateEnvFile(join(settingsDir(), '.env'), gone);
        return change(res, { ...chatgptView() });
      }
      res.json({ ok: true, restarting: false, restartNeeded: false, ...chatgptView() });
    }),
  );
  api.post(
    '/embeddings/models',
    wrap(async (req, res) => {
      const body = z.object({ baseUrl: webUrl(500).optional().or(z.literal('')), apiKey: visible(500).optional() }).parse(req.body);
      const baseUrl = body.baseUrl?.replace(/\/+$/, '') || undefined;
      res.json({ models: await listEmbeddingModels({ baseUrl, apiKey: body.apiKey || savedEmbeddingKey(baseUrl) }) });
    }),
  );
  api.post(
    '/index/reembed',
    wrap(async (_req, res) => {
      if (vectorJob?.running) return refuse(res, 409, 'New vectors are already being made.');
      const job: NonNullable<typeof vectorJob> = { running: true, done: 0, total: 0, error: null };
      vectorJob = job;
      // Runs on after the answer: the page reads its progress from /state. A restart stops it, and the passages
      // still without a vector are picked up when the server is back (the folder scan fills them in).
      void reembed((done, total) => Object.assign(job, { done, total }))
        .then((r) => {
          if (!r.ok) job.error = r.why;
        })
        .catch((e) => {
          job.error = msg(e);
        })
        .finally(() => {
          job.running = false;
        });
      res.json({ ok: true });
    }),
  );
  // ── How documents are cut into passages, and measuring what search finds (index_profile.ts, measure.ts) ──
  const way = z.object({ cut: z.enum(['sections', 'windows']), maxTokens: z.number().int().min(100).max(4000) });
  api.post(
    '/index/profile',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const body = way
        .extend({
          overlapTokens: z.number().int().min(0).max(1000).nullable().optional(),
          header: z.enum(['heading', 'document', 'none']),
          // null: back to what the model was trained with (or none). A string: as written.
          queryPrefix: z.string().max(500).nullable().optional(),
          passagePrefix: z.string().max(500).nullable().optional(),
        })
        .strict()
        .parse(req.body);
      const dir = settingsDir();
      const config = readConfigFile(dir);
      const next: Record<string, unknown> = { cut: body.cut, maxTokens: body.maxTokens, header: body.header };
      if (typeof body.overlapTokens === 'number') next.overlapTokens = Math.min(body.overlapTokens, Math.floor(body.maxTokens / 2) - 1);
      // Both prefixes together, or neither: one set by hand with the other left to the model would mix two sources.
      if (typeof body.queryPrefix === 'string' || typeof body.passagePrefix === 'string') {
        next.queryPrefix = body.queryPrefix ?? '';
        next.passagePrefix = body.passagePrefix ?? '';
      }
      const isDefault = next.cut === 'sections' && next.maxTokens === 800 && next.header === 'heading' && next.overlapTokens === undefined && next.queryPrefix === undefined;
      const knowledge = { ...(config.knowledge ?? {}) };
      if (isDefault) delete knowledge.index;
      else knowledge.index = next;
      if (Object.keys(knowledge).length) config.knowledge = knowledge;
      else delete config.knowledge;
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      change(res, { note: 'Saved. Documents are cut the new way as the folders are read again, starting now.' });
    }),
  );
  api.get('/index/measure', wrap(async (_req, res) => void res.json({ ...measureView(), ways: WAYS })));
  api.post(
    '/index/measure',
    wrap(async (req, res) => {
      const body = z.object({ what: z.enum(['measure', 'compare']), fresh: z.boolean().optional(), agent: z.enum(['low', 'medium', 'high']).optional() }).strict().parse(req.body);
      startMeasure(body.what, body.fresh === true, body.agent ?? null);
      res.json({ ...measureView(), ways: WAYS });
    }),
  );
  api.post(
    '/index/measure/stop',
    wrap(async (_req, res) => {
      stopMeasure();
      res.json({ ...measureView(), ways: WAYS });
    }),
  );
  api.delete(
    '/services/:id',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const names = id === 'embeddings' ? ['OPENAI_API_KEY', 'EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIM'] : SERVICE_ENV[id];
      if (!names) return refuse(res, 404, 'There is no such service.');
      const envPath = join(settingsDir(), '.env');
      const inFile = readEnvKeys(envPath);
      const outside = names.filter((n) => process.env[n]?.trim() && !inFile.has(n));
      // The key that was pasted into the console lives in a file the console wrote: it goes with the connection.
      // A key file somebody put elsewhere is theirs and stays.
      const pasted = join(settingsDir(), 'drive-service-account.json');
      if (id === 'drive' && resolve(settingsDir(), readEnvValues(envPath).get('GOOGLE_APPLICATION_CREDENTIALS') ?? '.') === pasted) rmSync(pasted, { force: true });
      // A sign-in goes with the connection too: its file here, and the permission at the other site.
      if (id === 'drive' && driveUsesLogin(settingsDir())) await signOutGoogle(settingsDir());
      if (id === 'railway' && railwaySignedIn()) await signOutRailway();
      updateEnvFile(envPath, Object.fromEntries(names.map((n) => [n, undefined])));
      change(res, outside.length ? { note: `${outside.join(', ')} is set outside .env (in the shell or the platform), so it stays on until it is removed there.` } : {});
    }),
  );
  api.post(
    '/drive/trust',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const { entries } = z.object({ entries: z.array(z.string().min(3).max(200)).min(1).max(20) }).parse(req.body);
      const clean = entries.map((e) => e.trim().toLowerCase());
      for (const e of clean) {
        const valid = validTrustEntry(e);
        if (valid !== true) return refuse(res, 422, valid);
      }
      change(res, { added: addTrusted(settingsDir(), clean) });
    }),
  );

  // ── Databases and APIs ──
  const ConnectionBody = z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, starting with a letter'),
    type: z.enum(['postgres', 'sqlite', 'http']),
    /** postgres: the connection string. Saved to .env under <NAME>_DATABASE_URL, never to the config. */
    url: visible(2000).optional(),
    path: oneLine(1000).optional(),
    baseUrl: webUrl(1000).optional().or(z.literal('')),
    headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, 'a header name'), oneLine(2000)).optional(),
    explore: z.boolean().optional(),
    description: oneLine(500).optional(),
  });
  api.post(
    '/connections',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const b = ConnectionBody.parse(req.body);
      const dir = settingsDir();
      if (BUILT_IN.has(b.name)) return refuse(res, 422, `"${b.name}" is the name of a built-in plugin. Pick another name.`);
      const config = readConfigFile(dir);
      const existing: ConnectionConfig | undefined = config.connections?.[b.name];
      let conn: Record<string, unknown>;
      let found = '';
      if (b.type === 'postgres') {
        const envName = existing?.type === 'postgres' ? existing.urlEnv : `${b.name.toUpperCase().replace(/-/g, '_')}_DATABASE_URL`;
        if (b.url?.trim()) {
          const r = await checkPostgresUrl(b.name, b.url.trim());
          updateEnvFile(join(dir, '.env'), { [envName]: b.url.trim() });
          found = `${r.version}, ${r.tables} table${r.tables === 1 ? '' : 's'} readable`;
        } else if (!process.env[envName]?.trim()) {
          return refuse(res, 422, 'Enter the connection string (postgres://user:password@host:5432/database).');
        }
        conn = { type: 'postgres', urlEnv: envName };
      } else if (b.type === 'sqlite') {
        if (!b.path?.trim()) return refuse(res, 422, 'Enter the path of the database file.');
        const full = resolve(dir, b.path.trim().replace(/^~(?=$|\/)/, homedir()));
        const r = await checkSqliteFile(b.name, full);
        found = `${r.version}, ${r.tables} table${r.tables === 1 ? '' : 's'}`;
        conn = { type: 'sqlite', path: full };
      } else {
        if (!b.baseUrl?.trim()) return refuse(res, 422, 'Enter the base URL of the API.');
        const headers = b.headers ?? {};
        refuseLiteralSecrets(headers, 'The header');
        const foreign = foreignEnvProblem(dir, Object.values(headers));
        if (foreign) return refuse(res, 422, foreign);
        conn = { type: 'http', baseUrl: b.baseUrl.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
      }
      if (b.explore && b.type !== 'http') conn.explore = true;
      if (b.description?.trim()) conn.description = b.description.trim();
      const all = { ...(config.connections ?? {}), [b.name]: conn };
      const parsed = ConnectionsSchema.parse(all);
      const tools = DataToolsSchema.safeParse(config.tools ?? []);
      const problems = tools.success ? dataConfigProblems(parsed, tools.data).filter((p) => p.path[0] === 'connections' || p.message.includes(`"${b.name}"`)) : [];
      if (problems.length) return refuse(res, 422, problems.map((p) => p.message).join(' '));
      config.connections = all;
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      change(res, { found });
    }),
  );
  api.delete(
    '/connections/:name',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const name = String(req.params.name);
      const config = readConfigFile(dir);
      if (!config.connections?.[name]) return refuse(res, 404, 'There is no such connection.');
      const used = (Array.isArray(config.tools) ? config.tools : []).filter((t: { connection?: string }) => t.connection === name).length;
      if (used) return refuse(res, 409, `${used} tool${used === 1 ? ' uses' : 's use'} this connection. Remove ${used === 1 ? 'it' : 'them'} first.`);
      delete config.connections[name];
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      change(res);
    }),
  );
  api.get(
    '/connections/:name/tables',
    wrap(async (req, res) => {
      const c = getConfig().connections[String(req.params.name)];
      if (!c || c.type === 'http') return refuse(res, 404, 'There is no such database connection.');
      res.json({ tables: await sqlAdapterFor(String(req.params.name), c).tables() });
    }),
  );

  // ── Declared tools ──
  /** The config with one tool put in or taken out, checked the way the server checks it at start. */
  const withTool = (dir: string, tool: z.infer<typeof DataToolSchema> | null, remove?: string) => {
    const config = readConfigFile(dir);
    const list: Array<{ name: string }> = Array.isArray(config.tools) ? config.tools : [];
    const name = tool?.name ?? remove!;
    const next = list.filter((t) => t.name !== name);
    if (tool) next.push(tool);
    const connections = ConnectionsSchema.parse(config.connections ?? {});
    const tools = DataToolsSchema.parse(next);
    const problems = dataConfigProblems(connections, tools).map((p) => p.message);
    return { config, connections, tools, problems, existed: next.length !== list.length || !tool };
  };
  // Check a tool without saving it: is the definition sound, and does the query compile on the real database?
  api.post(
    '/tools/check',
    wrap(async (req, res) => {
      const tool = DataToolSchema.parse(req.body);
      const { connections, problems } = withTool(settingsDir(), tool);
      const foreign = foreignEnvProblem(settingsDir(), toolStrings(tool));
      if (foreign) problems.push(foreign);
      if (problems.length) return res.json({ ok: false, problems });
      const c = connections[tool.connection];
      if (c.type === 'http') return res.json({ ok: true, note: 'The request is well formed. Save it and try it to see what the API answers.' });
      const lines = await checkConnection(tool.connection, c, [tool]);
      const bad = lines.filter((l) => !l.ok);
      res.json(bad.length ? { ok: false, problems: bad.map((l) => l.text) } : { ok: true, note: 'The query compiles on the database.' });
    }),
  );
  api.post(
    '/tools',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const tool = DataToolSchema.parse(req.body);
      const dir = settingsDir();
      const { problems } = withTool(dir, tool);
      const foreign = foreignEnvProblem(dir, toolStrings(tool));
      if (foreign) problems.push(foreign);
      if (problems.length) return refuse(res, 422, problems.join(' '));
      // A name another plugin already uses would stop the server at start.
      const clash = registry.listTools(pingTool).find((t) => t.name === tool.name && !getConfig().tools.some((d) => d.name === t.name));
      if (clash) return refuse(res, 409, `A tool named "${tool.name}" already exists. Pick another name.`);
      // Keep the file as the person wrote it where nothing changed: only this tool's entry is new.
      const raw = readConfigFile(dir);
      const rawList: Array<{ name: string }> = Array.isArray(raw.tools) ? raw.tools : [];
      raw.tools = [...rawList.filter((t) => t.name !== tool.name), req.body];
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(raw, null, 2)}\n`);
      change(res);
    }),
  );
  api.delete(
    '/tools/:name',
    wrap(async (req, res) => {
      if (!mustEdit(res)) return;
      const dir = settingsDir();
      const raw = readConfigFile(dir);
      const list: Array<{ name: string }> = Array.isArray(raw.tools) ? raw.tools : [];
      const next = list.filter((t) => t.name !== String(req.params.name));
      if (next.length === list.length) return refuse(res, 404, 'There is no such declared tool.');
      raw.tools = next;
      writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(raw, null, 2)}\n`);
      change(res);
    }),
  );

  /**
   * Run a tool from the console: the same call an AI client makes, on the same footing as a client on this machine
   * (stdio), the admin, with the caller set for the whole call so tools that ask who is calling get an answer. A
   * call from here is a call: it reaches the same databases and services, so it is in the same record.
   */
  const runAsConsole = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; ms: number }> => {
    const started = Date.now();
    const auth: AuthContext = { ok: true, org_id: getConfig().orgId, role: 'admin', email: CONSOLE_EMAIL };
    const r = await authStore.run(auth, () => registry.call(name, args, auth));
    logToolCall({ tool: name, auth, ok: r.isError !== true, error: r.isError === true ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? null : null, durationMs: Date.now() - started });
    const text = r.content.map((c) => (c.type === 'text' ? String((c as { text?: unknown }).text ?? '') : `[${c.type}]`)).join('\n');
    return { ok: r.isError !== true, text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… [${text.length - 60_000} more characters]` : text, ms: Date.now() - started };
  };

  // Try a tool by hand.
  api.post(
    '/run',
    wrap(async (req, res) => {
      const { name, args } = z.object({ name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      res.json(await runAsConsole(name, args));
    }),
  );

  /**
   * The tools the chat offers the model: the ones that only read, by their own word (readOnlyHint). A tool that
   * says nothing about it, or that changes things, is left out: the model decides what to call, and nothing it
   * decides here should change data. Those are tried by hand above.
   */
  // One that writes is offered as well: save_note, which writes only new notes into this server's notes/ folder
  // (and replaces notes it wrote there): the person asks the chat to keep what it made.
  const chatTools = (): ChatTool[] =>
    registry
      .listTools(pingTool)
      .filter((t) => t.name !== pingTool.name && (t.annotations?.readOnlyHint === true || t.name === 'save_note') && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> }));
  const CHAT_RULES = [
    'You are answering in the console of this MCP server, where its owner tries how its tools work for an AI assistant.',
    'Use the tools to find the answer, as an assistant connected to this server would. Say which documents or sources the answer comes from.',
    'If the tools find nothing that answers the question, say so plainly instead of answering from memory.',
    'When the person asks to keep something (notes on a document, a summary), save it with save_note; it goes into the notes folder of this server.',
    'Answer in the language of the question.',
  ].join('\n');
  api.get('/chat', wrap(async (_req, res) => void res.json({ tools: chatTools().map((t) => t.name), left: registry.listTools(pingTool).filter((t) => t.name !== pingTool.name).length - chatTools().length })));
  // ── Conversations kept on this machine (chats.ts) ──
  api.get('/chats', wrap(async (_req, res) => void res.json({ chats: listChats() })));
  api.get(
    '/chats/:id',
    wrap(async (req, res) => {
      const chat = readChat(String(req.params.id));
      if (!chat) return refuse(res, 404, 'There is no such conversation.');
      res.json(chat);
    }),
  );
  api.delete(
    '/chats/:id',
    wrap(async (req, res) => {
      if (!deleteChat(String(req.params.id))) return refuse(res, 404, 'There is no such conversation.');
      res.json({ ok: true });
    }),
  );
  api.post(
    '/chat',
    wrap(async (req, res) => {
      const body = z
        .object({
          message: z.string().trim().min(1).max(20_000),
          /** Go on with this conversation: what the model is given comes from it (chats.ts historyOf). */
          chatId: z.string().max(64).optional(),
          /** A page that keeps no conversation sends the text of the turns so far itself. */
          history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(100_000) }).strict()).max(200).default([]),
        })
        .strict()
        .parse(req.body);
      const settings = llmSettings();
      if (!settings) return refuse(res, 409, 'No language model is connected. Connect one on the Models page.');
      const found = body.chatId ? readChat(body.chatId) : null;
      if (body.chatId && !found) return refuse(res, 404, 'There is no such conversation.');
      if (found?.answering) return refuse(res, 409, 'An answer is still being written in this conversation. Open it again in a moment.');
      const { history, left } = found ? historyOf(found) : { history: body.history.filter((h) => h.text.trim()), left: 0 };
      const chat = found ?? newChat(body.message);
      // The question is kept before the model is asked: leaving the page in the middle does not lose it.
      const startedAt = Date.now();
      chat.turns.push({ role: 'user', text: body.message, at: new Date(startedAt).toISOString() });
      chat.answering = true;
      chat.updated = new Date(startedAt).toISOString();
      writeChat(chat);
      const answer: StoredTurn = { role: 'assistant', text: '', at: new Date(startedAt).toISOString(), calls: [] };
      // One event per line, as they happen. The page reads them while the answer is written.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const stop = new AbortController();
      // The page closed the request (Stop, or it went away): the model is stopped too.
      res.on('close', () => {
        if (!res.writableEnded) stop.abort();
      });
      const send = (e: ChatEvent | { type: 'chat'; id: string; title: string }) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
      };
      // What the page is sent is kept with the conversation as well.
      const emit = (e: ChatEvent) => {
        if (e.type === 'text') answer.text += e.text;
        else if (e.type === 'tool') answer.calls!.push({ id: e.id, name: e.name, input: e.input });
        else if (e.type === 'result') Object.assign(answer.calls!.find((c) => c.id === e.id) ?? {}, { ok: e.ok, text: e.text, ms: e.ms });
        else if (e.type === 'done') answer.end = { model: e.model, usage: e.usage, note: e.note, seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)) };
        else if (e.type === 'error') answer.error = e.message;
        send(e);
      };
      send({ type: 'chat', id: chat.id, title: chat.title });
      const instructions = registry.instructions();
      try {
        const end = await converse(
          {
            system:
              `${CHAT_RULES}\n\nWhat this server tells the assistants that connect to it:\n${instructions}` +
              (left ? `\n\nThis conversation is longer than what you are given: its first ${left} message${left === 1 ? ' is' : 's are'} left out.` : ''),
            history,
            message: body.message,
            tools: chatTools(),
            run: async (name, input) => runAsConsole(name, input),
            emit,
            signal: stop.signal,
          },
          settings,
        );
        emit({ type: 'done', ...end });
      } catch (e) {
        if (!stop.signal.aborted) emit({ type: 'error', message: msg(e) });
      } finally {
        // Kept whatever happened: answered, failed, or stopped by the person.
        answer.end ??= answer.error ? undefined : { model: settings.model, usage: { input: 0, output: 0, cached: 0, steps: 0 }, note: 'Stopped.', seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)) };
        chat.turns.push(answer);
        chat.answering = false;
        chat.updated = new Date().toISOString();
        try {
          // Deleted while the answer was written: it stays deleted.
          if (readChat(chat.id)) writeChat(chat);
        } catch (e) {
          console.error('[console] could not keep the conversation:', msg(e));
        }
      }
      res.end();
    }),
  );

  // ── How to connect an AI client ──
  /** This server as a client's entry: its name, and how to start it from this folder. */
  const clientEntry = (): Entry => {
    const name = (getConfig().branding?.name ?? 'knowledge').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'knowledge';
    return { name, ...stdioEntry(settingsDir()) };
  };
  api.get(
    '/clients',
    wrap(async (req, res) => {
      const entry = clientEntry();
      const url = `http://${req.headers.host}/mcp`;
      res.json({
        name: entry.name,
        url,
        clients: describeClients(entry),
        http: JSON.stringify({ mcpServers: { [entry.name]: { url, headers: { Authorization: 'Bearer <key>' } } } }, null, 2),
      });
    }),
  );
  api.post(
    '/clients/:id/add',
    wrap(async (req, res) => {
      const id = z.enum(CLIENT_IDS).parse(req.params.id);
      res.json({ ok: true, message: addToClient(id, clientEntry()) });
    }),
  );

  // ── People and keys ──
  api.get(
    '/people',
    wrap(async (_req, res) => {
      const store = await getStore();
      const [users, keys] = await Promise.all([store.listUsers(), store.listKeys()]);
      res.json({ users, keys, groups: registry.status().map((p) => p.id) });
    }),
  );
  api.post(
    '/people/users',
    wrap(async (req, res) => {
      const b = z.object({ email: z.string().email().max(200), role: z.enum(['admin', 'member']).default('member'), tools: z.array(z.string()).max(50).nullable().optional() }).parse(req.body);
      const store = await getStore();
      const existing = await store.getUser(b.email.toLowerCase());
      await store.upsertUser({ ...existing, email: b.email.toLowerCase(), role: b.role, allowedTools: b.tools === undefined ? existing?.allowedTools ?? null : b.tools?.length ? b.tools : null });
      res.json({ ok: true });
    }),
  );
  api.delete(
    '/people/users/:email',
    wrap(async (req, res) => {
      const ok = await (await getStore()).removeUser(String(req.params.email).toLowerCase());
      if (!ok) return refuse(res, 404, 'There is no such person.');
      res.json({ ok: true });
    }),
  );
  api.post(
    '/people/keys',
    wrap(async (req, res) => {
      const b = z.object({ email: z.string().email().max(200), label: z.string().max(100).optional() }).parse(req.body);
      const store = await getStore();
      const email = b.email.toLowerCase();
      // A key acts as the person it belongs to, so the person has to be registered first.
      if (!(await store.getUser(email))) await store.upsertUser({ email, role: 'member' });
      const created = await store.createKey({ email, role: 'member', orgId: getConfig().orgId, label: b.label?.trim() || 'console', expiresAt: null });
      res.json({ ok: true, id: created.id, key: created.key }); // shown once; only its hash is stored
    }),
  );
  api.post(
    '/people/keys/:id/revoke',
    wrap(async (req, res) => {
      const ok = await (await getStore()).revokeKey(String(req.params.id));
      if (!ok) return refuse(res, 404, 'There is no such key.');
      res.json({ ok: true });
    }),
  );

  // ── Activity ──
  api.get(
    '/activity',
    wrap(async (req, res) => {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
      res.json({ calls: await (await getStore()).recentToolCalls(limit) });
    }),
  );

  api.use((_req, res) => refuse(res, 404, 'There is no such console endpoint.'));

  const router = express.Router();
  // Every answer from here says whose it is, the refusals too. The page reads "not allowed" as "my token is not
  // accepted" only when this server said it: another program that answers on the same address for a moment (while
  // this server restarts) has no say about the token.
  router.use((_req, res, next) => {
    res.setHeader(CONSOLE_HEADER, '1');
    next();
  });
  router.use(localOnly);
  router.use((_req, res, next) => {
    // The page loads nothing from anywhere else, cannot be framed, and tells no other site where it was.
    // (Styles are inline because the components carry their own.)
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use('/api', api);
  // The browser the server opened: trade the one-time code for the address with the token. Anything else lands on
  // the page, which works if this browser already has the token and asks for it if not.
  router.get('/open', (req, res) => void res.redirect(302, redeemOpenCode(String(req.query.code ?? '')) ? `/console/#token=${consoleToken()}` : '/console/'));
  // A browser that has no token (another browser, another port) can ask the server to open the console for the
  // person at the machine, instead of sending them to look for an address in the terminal. Nothing is handed to
  // whoever asks: the console opens in the browser of the one who runs the server, with a one-time address that
  // is kept off the command line (launch.ts). Asked by the console page only, and not over and over.
  let openedAt = 0;
  router.post('/open-here', (req, res) => {
    if (foreignPage(req.headers)) return void res.status(403).json({ error: 'Only the console page asks for this.' });
    if (process.env.CI || !consoleOpens()) return void res.status(409).json({ error: 'This server cannot open a browser. Use the address it printed in the terminal.' });
    if (Date.now() - openedAt < 10_000) return void res.status(429).json({ error: 'The console was just opened. Look at your browser.' });
    openedAt = Date.now();
    openInBrowser(consoleOpenUrl(req.socket.localPort ?? 0));
    res.json({ ok: true });
  });
  // The browser comes back from Railway or Google. It carries no console token (it arrives from another site), so
  // this accepts only the answer to a sign-in started from the console minutes ago, and saves nothing by itself.
  router.get(CALLBACK_PATH.replace(/^\/console/, ''), (req, res) => {
    void finishChatgptSignIn(req.query as Record<string, unknown>).then((r) => {
      const text = r.text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      res
        .status(r.ok ? 200 : 400)
        .type('html')
        .set('Cache-Control', 'no-store')
        .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        .send(
          `<!doctype html><meta charset="utf-8"><title>Knowledge MCP</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:520px;margin:18vh auto;padding:0 20px;color:#1a1a19}h1{font-size:18px;margin:0 0 8px}</style><h1>${r.ok ? 'Signed in to ChatGPT' : 'Not signed in'}</h1><p>${text}</p>`,
        );
    });
  });
  router.get('/login/:service', (req, res) => {
    completeLogin(String(req.params.service), req.query as Record<string, unknown>).then(
      (page) => res.redirect(302, page),
      () => res.redirect(302, '/console/'),
    );
  });
  if (ui) {
    router.use(express.static(ui, { index: 'index.html', maxAge: 0 }));
    router.get(/.*/, (_req, res) => res.sendFile(join(ui, 'index.html')));
  } else {
    router.get(/.*/, (_req, res) => void res.status(503).type('text/plain').send('The console page is not built in this copy of the server. Build the package (npm run build), or use the setup commands.'));
  }
  app.use('/console', router);
  app.get('/', (req, res, next) => (localOnlyQuiet(req) ? res.redirect('/console/') : next()));
  return true;
}

/** Is this a request the console would accept? (For the redirect from "/": others get the plain 404.) */
function localOnlyQuiet(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host ?? ''));
}
