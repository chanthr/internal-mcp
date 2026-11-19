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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { configSource, getConfig } from '../core/config.js';
import { home } from '../core/paths.js';
import { authStore } from '../core/context.js';
import { logToolCall } from '../store/tool_log.js';
import type { AuthContext } from '../core/auth.js';
import { cli, stdioEntry } from '../core/invocation.js';
import { addToClient, CLIENT_IDS, describeClients, type Entry } from './clients.js';
import { getStore } from '../store/index.js';
import type { Registry } from '../plugin/registry.js';
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
import { DRIVE_COLLECTION, getLocalIndex, vectorProblem } from '../plugins/drive/qdrant.js';
import { isTrusted, trustEntryFor, validTrustEntry } from '../plugins/drive/trust.js';
import { checkDriveCredentials, checkEmbedding, listEmbeddingModels, checkGithub, checkPostgresUrl, checkRailway, checkSlack, checkSqliteFile } from '../setup/checks.js';
import { addTrusted, BUILT_IN, configuredFolders, readConfigFile, refuseLiteralSecrets, runSetupCommand, trustedList } from '../setup/commands.js';
import { readEnvKeys, readEnvValues, updateEnvFile } from '../setup/envfile.js';
import { countDocuments } from '../setup/wizard.js';
import { backgroundExec, createDriveServiceAccount, gcloudAccount } from '../setup/auto.js';
import { railwayAuth, railwaySignedIn, readRailwayLogin } from '../plugins/railway/login.js';
import { consoleEnabled, consoleToken, localOnly, tokenRequired } from './auth.js';
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
import { mcpTarget, needsSignIn, prefixOf, removeUpstream, signOutMcp, tokenEnvOf, toolsFound, upsertUpstream, upstreamEntries } from './upstreams.js';
import { probeUpstream } from '../core/upstream.js';
import { readUpstreamLogin, UPSTREAM_NAME, upstreamSignedIn } from '../core/upstream_login.js';
import { canReload, requestReload } from './supervisor.js';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Folder that holds .env and mcp.config.json: where the loaded config file is, else the working directory. */
export function settingsDir(): string {
  const source = configSource();
  return source.startsWith('file:') ? dirname(source.slice(5)) : home() ?? process.cwd();
}

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
};
const isSet = (names: string[]) => names.some((n) => !!process.env[n]?.trim());

/** How Drive is connected: a key (service account) or a sign-in, and for a sign-in who it is and which folders are read. */
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
function railwayVia(): { set: boolean; via: 'token' | 'login' | null; who: string | null } {
  if (isSet(SERVICE_ENV.railway)) return { set: true, via: 'token', who: null };
  if (railwaySignedIn()) return { set: true, via: 'login', who: readRailwayLogin().who ?? null };
  return { set: false, via: null, who: null };
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
  'OPENAI_API_KEY', 'EMBEDDING_API_KEY', 'QDRANT_API_KEY', 'MATHPIX_APP_ID', 'MATHPIX_APP_KEY',
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
        index = { ...s, meaning: embeddingsConfigured() && !problem, problem, vectorsFrom: made && made.vectors > 0 ? made.model ?? 'another model' : null, job: vectorJob };
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
        services: {
          drive: { set: isSet(SERVICE_ENV.drive), trusted: trustedList({ dir }), ...driveVia(dir) },
          slack: { set: isSet(SERVICE_ENV.slack) },
          github: { set: isSet(SERVICE_ENV.github) },
          railway: railwayVia(),
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
  api.get(
    '/logins/google',
    wrap(async (req, res) => {
      const saved = readGoogleLogin();
      res.json({ clientSaved: !!saved, account: saved?.account ?? null, redirectUri: `${origin(req)}/console/login/google` });
    }),
  );
  api.post('/logins/railway', wrap(async (req, res) => void res.json({ url: await startRailwayLogin(origin(req)) })));
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
      if (await needsSignIn(target.url)) return void res.json({ signIn: await startMcpLogin(origin(req), target) });
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

  // Try a tool: the same call an AI client makes, as an admin.
  api.post(
    '/run',
    wrap(async (req, res) => {
      const { name, args } = z.object({ name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      const started = Date.now();
      // The same footing as a client on this machine (stdio): the admin, with the caller set for the whole call so
      // tools that ask who is calling (search, documents) get an answer.
      const auth: AuthContext = { ok: true, org_id: getConfig().orgId, role: 'admin', email: 'console@localhost' };
      const r = await authStore.run(auth, () => registry.call(name, args, auth));
      // A call from here is a call: it reaches the same databases and services, so it is in the same record.
      logToolCall({ tool: name, auth, ok: r.isError !== true, error: r.isError === true ? (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? null : null, durationMs: Date.now() - started });
      const text = r.content.map((c) => (c.type === 'text' ? String((c as { text?: unknown }).text ?? '') : `[${c.type}]`)).join('\n');
      res.json({ ok: r.isError !== true, text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… [${text.length - 60_000} more characters]` : text, ms: Date.now() - started });
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
  // The browser comes back from Railway or Google. It carries no console token (it arrives from another site), so
  // this accepts only the answer to a sign-in started from the console minutes ago, and saves nothing by itself.
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
