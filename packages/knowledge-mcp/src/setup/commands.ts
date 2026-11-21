/**
 * Setup commands that ask no questions, for scripts and for AI agents that set the server up on someone's behalf.
 *
 *   knowledge-mcp setup check                          verify every configured service live, exit 1 on a failure
 *   knowledge-mcp setup folder <path> [--name N] [--source L]
 *                                                      index a local folder of documents (no account, no key)
 *   knowledge-mcp setup drive --gcloud [--project ID] [--yes]
 *                                                      create the Drive service account and key with gcloud
 *   knowledge-mcp setup drive --key <file>             use an existing key file
 *   knowledge-mcp setup trust <email-or-domain>...     whose shared Drive documents are shown
 *   knowledge-mcp setup github --from-gh               reuse the gh CLI login
 *   knowledge-mcp setup embeddings --base-url URL --model NAME
 *                                                      a keyless OpenAI-compatible endpoint (a local model)
 *   knowledge-mcp setup connection <name> --postgres --env NAME | --sqlite <file> | --http <base URL>
 *                                                      a database or an API for declared tools (see connections/schema.ts)
 *   knowledge-mcp setup secret <ENV_NAME>              type one secret into .env without showing it (needs a terminal)
 *
 * Secrets are never taken as arguments: an argument ends up in shell history and in an agent's transcript.
 * A key that has to be typed (OpenAI, Slack, a GitHub token, a database URL) goes through the interactive
 * `knowledge-mcp setup` or `setup secret <ENV_NAME>`, typed by the person who owns it. `setup check` then tells whether it works.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTrusted, trustEntryFor, validTrustEntry } from '../plugins/drive/trust.js';
import { railwayAuth, railwaySignedIn } from '../plugins/railway/login.js';
import { checkDrive, checkDriveCredentials, checkEmbedding, checkGithub, checkRailway, checkSlack } from './checks.js';
import { updateEnvFile } from './envfile.js';
import { ConnectionsSchema, DataToolsSchema, dataConfigProblems, envRefs, exploreToolNames, type ConnectionConfig, type DataToolConfig } from '../connections/schema.js';
import { checkConnection, closeDataConnections } from '../connections/index.js';
import { formatValidationError } from '../plugin/result.js';
import { countDocuments } from './wizard.js';
import { cli } from '../core/invocation.js';
import { writeFileAtomic } from '../core/data_file.js';
import {
  createDriveServiceAccount,
  gcloudAccount,
  gcloudDefaultProject,
  ghToken,
  hasTool,
  serviceAccountCommands,
  serviceAccountEmail,
  systemExec,
  type Exec,
} from './auto.js';

export interface CommandContext {
  dir: string;
  out: (line: string) => void;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  endpoints?: { drive?: string; slack?: string; github?: string; railway?: string };
  retryDelayMs?: number;
  /** Reads a secret without showing it. Default: the terminal. Tests pass a fake. */
  readSecret?: (question: string) => Promise<string>;
}

export const SETUP_USAGE = `setup                      guided setup (asks questions; needs a terminal)
       setup check                verify every configured service live
       setup folder <path> [--name N] [--source LABEL]
       setup drive --gcloud [--project ID] [--yes]
       setup drive --key <file>
       setup trust <email-or-domain>...
       setup github --from-gh
       setup embeddings --base-url URL --model NAME
       setup connection <name> --postgres --env NAME [--explore]
       setup connection <name> --sqlite <file> [--explore]
       setup connection <name> --http <base URL> [--header 'Name: value']... [--query key=value]...
       setup secret <ENV_NAME>`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function readConfigFile(dir: string): Record<string, any> {
  const path = join(dir, 'mcp.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${msg(e)})`);
  }
}

/** Save mcp.config.json whole: a save that fails (a full disk) leaves the file as it was, not cut short. */
export function writeConfigFile(dir: string, config: Record<string, unknown>): void {
  writeFileAtomic(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** drive.trustedOwners as the server will read it: env DRIVE_TRUSTED_OWNERS first, then mcp.config.json. */
export function trustedList(ctx: Pick<CommandContext, 'dir' | 'env'>): string[] {
  const env = (ctx.env ?? process.env).DRIVE_TRUSTED_OWNERS;
  const list: unknown = env !== undefined ? env.split(',') : readConfigFile(ctx.dir).drive?.trustedOwners;
  return (Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/** Add entries to drive.trustedOwners in mcp.config.json. Returns the entries that were new. */
export function addTrusted(dir: string, entries: string[]): string[] {
  const config = readConfigFile(dir);
  const current: string[] = Array.isArray(config.drive?.trustedOwners) ? config.drive.trustedOwners.map((x: unknown) => String(x).toLowerCase()) : [];
  const added = [...new Set(entries.map((e) => e.trim().toLowerCase()).filter(Boolean))].filter((e) => !current.includes(e));
  if (added.length) {
    config.drive = { ...(config.drive ?? {}), trustedOwners: [...current, ...added] };
    writeConfigFile(dir, config);
  }
  return added;
}

/** Folders listed in mcp.config.json, with absolute paths. */
export function configuredFolders(dir: string): Array<{ path: string; name?: string }> {
  const list: unknown = readConfigFile(dir).folders;
  return (Array.isArray(list) ? list : [])
    .filter((f): f is { path: string; name?: string } => !!f && typeof (f as { path?: unknown }).path === 'string')
    .map((f) => ({ ...f, path: resolve(dir, f.path) }));
}

async function folder(argv: string[], ctx: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: { name: { type: 'string' }, source: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1) throw new Error('setup folder needs one path');
  const path = resolve(ctx.dir, positionals[0]);
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    /* does not exist */
  }
  if (!isDir) throw new Error(`${path} is not a folder`);
  if (values.name && !/^[^/\\]{1,64}$/.test(values.name)) throw new Error('--name must not contain a slash (max 64 characters)');
  if (values.source && !/^[a-z][a-z0-9_-]{0,31}$/.test(values.source)) throw new Error('--source must be lowercase letters, digits, dashes or underscores, starting with a letter');
  const config = readConfigFile(ctx.dir);
  const list: Array<{ path: string; name?: string; source?: string }> = Array.isArray(config.folders) ? config.folders : [];
  const n = countDocuments(path);
  if (list.some((f) => resolve(ctx.dir, f.path) === path)) {
    ctx.out(`· ${path} is already listed (${n} documents).`);
    return 0;
  }
  list.push({ path, ...(values.name ? { name: values.name } : {}), ...(values.source ? { source: values.source } : {}) });
  config.folders = list;
  writeConfigFile(ctx.dir, config);
  ctx.out(`✓ ${path} added: ${n} document${n === 1 ? '' : 's'} (Markdown, text, PDF, Word, PowerPoint, Excel). Saved to ${join(ctx.dir, 'mcp.config.json')}.`);
  ctx.out(`  The server indexes it the next time it starts. To index it now: ${cli('knowledge scan')}`);
  ctx.out('  Search works by keywords without any key. An embedding model (setup embeddings) adds search by meaning.');
  return 0;
}

async function trust(argv: string[], ctx: CommandContext): Promise<number> {
  if (argv.length === 0) throw new Error('setup trust needs at least one email, domain or drive:<id>');
  for (const entry of argv) {
    const ok = validTrustEntry(entry);
    if (ok !== true) throw new Error(ok);
  }
  const added = addTrusted(ctx.dir, argv);
  const all = trustedList({ ...ctx, env: {} });
  ctx.out(added.length ? `✓ Now trusted: ${added.join(', ')}. Saved to ${join(ctx.dir, 'mcp.config.json')}.` : '· Already trusted.');
  ctx.out(`  Shared Drive documents are shown when their owner is one of: ${all.join(', ')}. Restart the server to apply.`);
  return 0;
}

/** Check everything that is configured. Returns the number of failures. */
async function check(ctx: CommandContext): Promise<number> {
  const env = ctx.env ?? process.env;
  const has = (k: string) => !!env[k]?.trim();
  let failed = 0;
  let checked = 0;
  // Each check is started as it is reached and none waits for another: five services answer in the time of the
  // slowest, not the sum. The lines are printed at the end, in the order the checks were started.
  const slots: Array<Promise<string[]>> = [];
  const say = (line: string) => void slots.push(Promise.resolve([line]));
  const run = (label: string, fn: () => Promise<string>) => {
    checked++;
    slots.push(
      (async () => fn())().then(
        (text) => [`✓ ${label.padEnd(11)} ${text}`],
        (e) => {
          failed++;
          return [`✗ ${label.padEnd(11)} ${msg(e)}`];
        },
      ),
    );
  };
  const trusted = trustedList(ctx);
  const driveSummary = (d: Awaited<ReturnType<typeof checkDrive>>) => {
    // A configured root is shown whoever owns it, so it does not count as hidden.
    const roots: unknown = readConfigFile(ctx.dir).drive?.roots;
    const rootIds = new Set((Array.isArray(roots) ? roots : []).map((r) => String((r as { id?: unknown })?.id ?? '')));
    const hidden = d.shared.filter((s) => !rootIds.has(s.id) && !isTrusted(trusted, s.owners, s.driveId));
    const who = [...new Set(hidden.flatMap((h) => (h.owners.length ? h.owners : h.driveId ? [`drive:${h.driveId}`] : [])))];
    return (
      `${d.email ?? 'refresh token'} — ${d.shared.length}${d.more ? '+' : ''} shared item${d.shared.length === 1 ? '' : 's'}` +
      (d.shared.length === 0 && d.email ? `. Share a folder or document with ${d.email} to make it searchable` : '') +
      (hidden.length
        ? `, ${hidden.length} hidden because the owner is not trusted (${who.slice(0, 4).join(', ')}${who.length > 4 ? ' …' : ''}). ` +
          `For the owners that are yours: ${cli('setup trust')} ${[...new Set(who.map((w) => (w.startsWith('drive:') ? w : trustEntryFor(w) ?? w)))].slice(0, 4).join(' ')}`
        : '')
    );
  };

  for (const f of configuredFolders(ctx.dir)) {
    run('folder', async () => {
      let isDir = false;
      try {
        isDir = statSync(f.path).isDirectory();
      } catch {
        /* does not exist */
      }
      if (!isDir) throw new Error(`${f.path} does not exist or is not a folder`);
      const n = countDocuments(f.path);
      return `${f.path} — ${n} document${n === 1 ? '' : 's'}`;
    });
  }

  // Databases and APIs: is the config sound, can each be reached, does each declared query compile there.
  const data = readDataConfig(ctx.dir);
  if (data.problems.length) {
    for (const p of data.problems) {
      checked++;
      failed++;
      say(`✗ ${'config'.padEnd(11)} ${p}`);
    }
    say('  The server does not start until mcp.config.json is fixed.');
  } else {
    slots.push(
      (async () => {
        try {
          const perConnection = await Promise.all(Object.entries(data.connections).map(([name, c]) => checkConnection(name, c, data.tools, env)));
          return perConnection.flat().map((line) => {
            checked++;
            if (!line.ok) failed++;
            return `${line.ok ? '✓' : '✗'} ${line.what.padEnd(11)} ${line.text}`;
          });
        } finally {
          await closeDataConnections();
        }
      })(),
    );
  }

  if (has('GOOGLE_SERVICE_ACCOUNT_KEY')) {
    run('drive', async () => driveSummary(await checkDriveCredentials(env.GOOGLE_SERVICE_ACCOUNT_KEY!, 'GOOGLE_SERVICE_ACCOUNT_KEY', { apiBase: ctx.endpoints?.drive })));
  } else if (has('GOOGLE_APPLICATION_CREDENTIALS')) {
    run('drive', async () => driveSummary(await checkDrive(resolve(ctx.dir, env.GOOGLE_APPLICATION_CREDENTIALS!), { apiBase: ctx.endpoints?.drive })));
  } else say('· drive       not configured');

  if (has('OPENAI_API_KEY') || has('EMBEDDING_API_KEY') || has('EMBEDDING_BASE_URL')) {
    run('embeddings', async () => {
      const r = await checkEmbedding({ baseUrl: env.EMBEDDING_BASE_URL, model: env.EMBEDDING_MODEL, apiKey: env.EMBEDDING_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() });
      const want = env.EMBEDDING_DIM?.trim() || (env.EMBEDDING_BASE_URL?.trim() ? '' : '1536');
      if (want && Number(want) !== r.dim && !/^text-embedding-3/.test(r.model)) {
        throw new Error(`${r.model} returns ${r.dim}-dimension vectors but EMBEDDING_DIM is ${want}. Set EMBEDDING_DIM=${r.dim} and reindex.`);
      }
      return `${r.model} (${r.dim} dimensions)`;
    });
  } else say('· embeddings  not configured (search works by keywords; an embedding model adds search by meaning)');

  if (has('SLACK_BOT_TOKEN')) run('slack', async () => { const r = await checkSlack(env.SLACK_BOT_TOKEN!.trim(), { apiBase: ctx.endpoints?.slack }); return `${r.team} as ${r.user}`; });
  else say('· slack       not configured');

  const gh = env.GITHUB_PAT?.trim() || env.GITHUB_TOKEN?.trim();
  if (gh) run('github', async () => `signed in as ${(await checkGithub(gh, { apiBase: ctx.endpoints?.github })).login}`);
  else say('· github      not configured');

  if (has('RAILWAY_TOKEN')) run('railway', async () => (await checkRailway(env.RAILWAY_TOKEN!.trim(), { apiBase: ctx.endpoints?.railway })).who);
  else if (railwaySignedIn()) {
    // Signed in from the console: the check gets a token the way the tools do, renewing it when the hour is up.
    run('railway', async () => {
      const auth = await railwayAuth();
      return `${(await checkRailway(auth.token, { apiBase: ctx.endpoints?.railway ?? auth.api })).who} (signed in from the console)`;
    });
  } else say('· railway     not configured');

  for (const slot of slots) for (const line of await slot) ctx.out(line);
  if (checked === 0) ctx.out(`Nothing is configured yet. Run \`${cli('setup')}\`.`);
  return failed;
}

async function drive(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { gcloud: { type: 'boolean' }, project: { type: 'string' }, key: { type: 'string' }, yes: { type: 'boolean' }, name: { type: 'string' } },
  });
  const envPath = join(ctx.dir, '.env');
  const exec = ctx.exec ?? systemExec;

  if (values.key) {
    const keyPath = resolve(ctx.dir, values.key);
    const d = await checkDrive(keyPath, { apiBase: ctx.endpoints?.drive });
    updateEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: keyPath });
    ctx.out(`✓ Drive connected as ${d.email ?? 'a refresh token'} (${d.shared.length}${d.more ? '+' : ''} shared items). Saved to ${envPath}.`);
    if (d.email) ctx.out(`  Share folders or documents with ${d.email} to make them searchable.`);
    const owners = [...new Set(d.shared.flatMap((s) => s.owners).map(trustEntryFor).filter((e): e is string => !!e))];
    const untrusted = owners.filter((o) => !trustedList(ctx).includes(o));
    if (untrusted.length) {
      ctx.out(`  Shared documents are shown only from trusted owners. What is shared now belongs to: ${untrusted.join(', ')}.`);
      ctx.out(`  Ask the person whether these are theirs, then run: ${cli('setup trust')} ${untrusted.join(' ')}`);
    }
    return 0;
  }
  if (!values.gcloud) throw new Error('setup drive needs --gcloud or --key <file>');

  if (!(await hasTool(exec, 'gcloud'))) {
    ctx.out('✗ The gcloud CLI is not installed. Install it (https://cloud.google.com/sdk/docs/install), then run this again.');
    return 1;
  }
  const account = await gcloudAccount(exec);
  if (!account) {
    ctx.out('✗ gcloud is not signed in. The person who owns the Google account must run this in a terminal (it opens a browser):');
    ctx.out('    gcloud auth login');
    return 1;
  }
  const project = values.project ?? await gcloudDefaultProject(exec);
  if (!project) {
    ctx.out('✗ No project chosen. Pass --project <id> (list them with: gcloud projects list).');
    return 1;
  }
  const plan = { project, name: values.name ?? 'knowledge-mcp-drive', keyPath: join(ctx.dir, 'drive-service-account.json') };
  ctx.out(`Signed in to Google Cloud as ${account}. Project: ${project}.`);
  ctx.out('This runs:');
  for (const c of serviceAccountCommands(plan)) ctx.out(`  ${c.join(' ')}`);
  ctx.out(`The account ${serviceAccountEmail(plan)} gets no project role. It can only read what is shared with it in Drive.`);
  if (!values.yes) {
    ctx.out('Nothing was created. Show this to the account owner, then run the same command with --yes.');
    return 2;
  }
  const r = await createDriveServiceAccount(exec, plan);
  updateEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: plan.keyPath });
  ctx.out(`✓ ${r.created ? 'Created' : 'Reused'} ${r.email}. Key saved to ${plan.keyPath}, path saved to ${envPath}.`);
  // A key that was created a moment ago can be refused for a few seconds.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const d = await checkDrive(plan.keyPath, { apiBase: ctx.endpoints?.drive });
      ctx.out(`✓ The key works. ${d.shared.length} item${d.shared.length === 1 ? '' : 's'} shared with it so far.`);
      break;
    } catch (e) {
      if (attempt === 6) ctx.out(`· The key is saved but does not answer yet (${msg(e)}). Run \`${cli('setup check')}\` in a minute.`);
      else await new Promise((res) => setTimeout(res, ctx.retryDelayMs ?? 4000));
    }
  }
  const own = trustEntryFor(account);
  if (own && addTrusted(ctx.dir, [own]).length) ctx.out(`✓ Documents owned by ${own} are trusted (the account that created this). Add others with: ${cli('setup trust <email-or-domain>')}`);
  ctx.out(`Next: share a Drive folder or document with ${r.email} (Viewer). search_drive sees it at once; search_knowledge after the next sync.`);
  return 0;
}

async function github(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'from-gh': { type: 'boolean' } } });
  if (!values['from-gh']) throw new Error(`setup github needs --from-gh (a token you type goes through \`${cli('setup')}\`)`);
  const exec = ctx.exec ?? systemExec;
  const token = (await hasTool(exec, 'gh')) ? await ghToken(exec) : null;
  if (!token) {
    ctx.out('✗ The gh CLI is not installed or not signed in. The account owner runs: gh auth login');
    return 1;
  }
  const r = await checkGithub(token, { apiBase: ctx.endpoints?.github });
  updateEnvFile(join(ctx.dir, '.env'), { GITHUB_PAT: token });
  ctx.out(`✓ GitHub connected as ${r.login}, using the gh login. Saved to ${join(ctx.dir, '.env')}.`);
  ctx.out('  Note: this token can do everything the gh login can. A fine-grained read-only token is the safer choice for a shared server.');
  return 0;
}

async function embeddings(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'base-url': { type: 'string' }, model: { type: 'string' } } });
  if (!values['base-url'] || !values.model) throw new Error('setup embeddings needs --base-url URL --model NAME');
  const env = ctx.env ?? process.env;
  const r = await checkEmbedding({ baseUrl: values['base-url'], model: values.model, apiKey: env.EMBEDDING_API_KEY?.trim() || undefined });
  updateEnvFile(join(ctx.dir, '.env'), { EMBEDDING_BASE_URL: values['base-url'], EMBEDDING_MODEL: values.model, EMBEDDING_DIM: String(r.dim) });
  ctx.out(`✓ ${r.model} answers with ${r.dim}-dimension vectors. Saved EMBEDDING_BASE_URL, EMBEDDING_MODEL and EMBEDDING_DIM.`);
  ctx.out('  The server builds the search index by itself the next time it starts.');
  return 0;
}

/** Names that are plugin ids already; a connection cannot take one (its name is its permission group). */
export const BUILT_IN = new Set(['knowledge', 'drive', 'slack', 'github', 'railway', 'ping']);

/** `connections` and `tools` of mcp.config.json, checked the way the server checks them at boot. */
export function readDataConfig(dir: string): { connections: Record<string, ConnectionConfig>; tools: DataToolConfig[]; problems: string[] } {
  const raw = readConfigFile(dir);
  const c = ConnectionsSchema.safeParse(raw.connections ?? {});
  const t = DataToolsSchema.safeParse(raw.tools ?? []);
  if (!c.success || !t.success) {
    const problems = [...(c.success ? [] : [`connections: ${formatValidationError(c.error)}`]), ...(t.success ? [] : [`tools: ${formatValidationError(t.error)}`])];
    return { connections: {}, tools: [], problems };
  }
  return { connections: c.data, tools: t.data, problems: dataConfigProblems(c.data, t.data).map((p) => p.message) };
}

/** "Name: value" or "key=value" pairs from repeated flags. */
function pairs(list: string[] | undefined, sep: string, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const i = item.indexOf(sep);
    if (i <= 0) throw new Error(`${flag} must look like ${sep === ':' ? "'Name: value'" : 'key=value'}`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

/** A header or query value that is a secret must be written as ${ENV_NAME}: the config file is not a place for secrets. */
export function refuseLiteralSecrets(values: Record<string, string>, what: string): void {
  for (const [k, v] of Object.entries(values)) {
    if (/authorization|api[-_]?key|token|secret|password|cookie/i.test(k) && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)) {
      throw new Error(`${what} "${k}" looks like a secret. Write its value as \${ENV_NAME} (for example ${k}: Bearer \${API_TOKEN}) and put the value in .env with: ${cli('setup secret API_TOKEN')}`);
    }
  }
}

async function connection(argv: string[], ctx: CommandContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      postgres: { type: 'boolean' },
      env: { type: 'string' },
      sqlite: { type: 'string' },
      http: { type: 'string' },
      header: { type: 'string', multiple: true },
      query: { type: 'string', multiple: true },
      explore: { type: 'boolean' },
      description: { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new Error('setup connection needs one name, for example: setup connection shop --postgres --env SHOP_DATABASE_URL');
  const name = positionals[0];
  if (BUILT_IN.has(name)) throw new Error(`"${name}" is the name of a built-in plugin; pick another name`);
  if ([values.postgres, values.sqlite !== undefined, values.http !== undefined].filter(Boolean).length !== 1) {
    throw new Error('choose one of: --postgres --env NAME, --sqlite <file>, --http <base URL>');
  }
  let conn: Record<string, unknown>;
  if (values.postgres) {
    if (!values.env) throw new Error('--postgres needs --env NAME: the name of the env var that holds the connection string. The string itself is never given to a command');
    conn = { type: 'postgres', urlEnv: values.env };
  } else if (values.sqlite !== undefined) {
    const path = resolve(ctx.dir, values.sqlite);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    conn = { type: 'sqlite', path };
  } else {
    const headers = pairs(values.header, ':', '--header');
    const query = pairs(values.query, '=', '--query');
    refuseLiteralSecrets(headers, 'the header');
    refuseLiteralSecrets(query, 'the query parameter');
    conn = { type: 'http', baseUrl: values.http, ...(Object.keys(headers).length ? { headers } : {}), ...(Object.keys(query).length ? { query } : {}) };
  }
  if (values.explore) {
    if (conn.type === 'http') throw new Error('--explore is for databases');
    conn.explore = true;
  }
  if (values.description) conn.description = values.description;

  const config = readConfigFile(ctx.dir);
  const existed = config.connections?.[name] !== undefined;
  const all = { ...(config.connections ?? {}), [name]: conn };
  const parsed = ConnectionsSchema.safeParse(all);
  if (!parsed.success) throw new Error(formatValidationError(parsed.error));
  const tools = DataToolsSchema.safeParse(config.tools ?? []);
  const problems = tools.success ? dataConfigProblems(parsed.data, tools.data).filter((p) => p.path[0] === 'connections' || p.message.includes(`"${name}"`)) : [];
  if (problems.length) throw new Error(problems.map((p) => p.message).join('; '));
  config.connections = all;
  writeConfigFile(ctx.dir, config);

  ctx.out(`✓ connection "${name}" ${existed ? 'updated' : 'added'} (${conn.type}). Saved to ${join(ctx.dir, 'mcp.config.json')}.`);
  const env = ctx.env ?? process.env;
  const needs =
    conn.type === 'postgres'
      ? [String(conn.urlEnv)]
      : conn.type === 'http'
        ? [...new Set(Object.values({ ...(conn.headers as object), ...(conn.query as object) }).map(String).flatMap(envRefs))]
        : [];
  for (const n of needs.filter((x) => !env[x]?.trim())) {
    ctx.out(`  ${n} is not set. The person who owns it types it into .env, unseen, with: ${cli('setup secret')} ${n}`);
  }
  if (conn.type === 'postgres') ctx.out('  Use a database user that can only read, and only what everyone using this server may see.');
  if (conn.explore) {
    ctx.out(`  explore is on: the assistant can run any read-only query through ${exploreToolNames(name).query}.`);
  } else if (conn.type !== 'http') {
    ctx.out(`  No tools yet. Declare them under "tools" in mcp.config.json, or run this again with --explore. Tables: ${cli(`${name} tables`)}`);
  } else {
    ctx.out('  No tools yet. Declare them under "tools" in mcp.config.json (one API request each).');
  }
  ctx.out(`  Then: ${cli('setup check')}`);
  return 0;
}

async function secret(argv: string[], ctx: CommandContext): Promise<number> {
  if (argv.length !== 1) throw new Error('setup secret needs one env var name, for example: setup secret SHOP_DATABASE_URL');
  const name = argv[0];
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error('an env var name holds letters, digits and underscores');
  let read = ctx.readSecret;
  let close = () => {};
  if (!read) {
    if (!process.stdin.isTTY) {
      throw new Error(`setup secret asks for the value without showing it, so it needs a terminal. The person who owns the secret runs it themselves: ${cli('setup secret')} ${name}`);
    }
    const { terminalIO } = await import('./terminal.js');
    const io = terminalIO();
    read = (q) => io.secret(q);
    close = () => io.close();
  }
  let value: string;
  try {
    value = (await read(`Value for ${name} (not shown):`)).trim();
  } finally {
    close();
  }
  if (!value) {
    ctx.out('· Nothing was entered, so nothing was changed.');
    return 1;
  }
  updateEnvFile(join(ctx.dir, '.env'), { [name]: value });
  ctx.out(`✓ ${name} saved to ${join(ctx.dir, '.env')} (readable by you only). Check it with: ${cli('setup check')}`);
  return 0;
}

/** Run one `setup <sub>` command. Returns the process exit code. */
export async function runSetupCommand(argv: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'check') return (await check(ctx)) > 0 ? 1 : 0;
    if (sub === 'drive') return await drive(rest, ctx);
    if (sub === 'trust') return await trust(rest, ctx);
    if (sub === 'folder') return await folder(rest, ctx);
    if (sub === 'github') return await github(rest, ctx);
    if (sub === 'embeddings') return await embeddings(rest, ctx);
    if (sub === 'connection') return await connection(rest, ctx);
    if (sub === 'secret') return await secret(rest, ctx);
  } catch (e) {
    ctx.out(`✗ ${msg(e)}`);
    return 1;
  }
  ctx.out(`usage: knowledge-mcp ${SETUP_USAGE}`);
  return 2;
}
