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
 *
 * Secrets are never taken as arguments: an argument ends up in shell history and in an agent's transcript.
 * A key that has to be typed (OpenAI, Slack, a GitHub token) goes through the interactive `knowledge-mcp setup`,
 * or straight into .env by the person who owns it. `setup check` then tells whether it works.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTrusted, trustEntryFor, validTrustEntry } from '../plugins/drive/trust.js';
import { checkDrive, checkDriveCredentials, checkEmbedding, checkGithub, checkRailway, checkSlack } from './checks.js';
import { updateEnvFile } from './envfile.js';
import { countDocuments } from './wizard.js';
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
}

export const SETUP_USAGE = `setup                      guided setup (asks questions; needs a terminal)
       setup check                verify every configured service live
       setup folder <path> [--name N] [--source LABEL]
       setup drive --gcloud [--project ID] [--yes]
       setup drive --key <file>
       setup trust <email-or-domain>...
       setup github --from-gh
       setup embeddings --base-url URL --model NAME`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readConfigFile(dir: string): Record<string, any> {
  const path = join(dir, 'mcp.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${msg(e)})`);
  }
}

/** drive.trustedOwners as the server will read it: env DRIVE_TRUSTED_OWNERS first, then mcp.config.json. */
function trustedList(ctx: CommandContext): string[] {
  const env = (ctx.env ?? process.env).DRIVE_TRUSTED_OWNERS;
  const list: unknown = env !== undefined ? env.split(',') : readConfigFile(ctx.dir).drive?.trustedOwners;
  return (Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/** Add entries to drive.trustedOwners in mcp.config.json. Returns the entries that were new. */
function addTrusted(dir: string, entries: string[]): string[] {
  const config = readConfigFile(dir);
  const current: string[] = Array.isArray(config.drive?.trustedOwners) ? config.drive.trustedOwners.map((x: unknown) => String(x).toLowerCase()) : [];
  const added = [...new Set(entries.map((e) => e.trim().toLowerCase()).filter(Boolean))].filter((e) => !current.includes(e));
  if (added.length) {
    config.drive = { ...(config.drive ?? {}), trustedOwners: [...current, ...added] };
    writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  }
  return added;
}

/** Folders listed in mcp.config.json, with absolute paths. */
function configuredFolders(dir: string): Array<{ path: string; name?: string }> {
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
  writeFileSync(join(ctx.dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  ctx.out(`✓ ${path} added: ${n} document${n === 1 ? '' : 's'} (Markdown, text, PDF, Word, PowerPoint, Excel). Saved to ${join(ctx.dir, 'mcp.config.json')}.`);
  ctx.out('  The server indexes it the next time it starts. To index it now: knowledge-mcp knowledge scan');
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
  const run = async (label: string, fn: () => Promise<string>) => {
    checked++;
    try {
      ctx.out(`✓ ${label.padEnd(11)} ${await fn()}`);
    } catch (e) {
      failed++;
      ctx.out(`✗ ${label.padEnd(11)} ${msg(e)}`);
    }
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
          `For the owners that are yours: knowledge-mcp setup trust ${[...new Set(who.map((w) => (w.startsWith('drive:') ? w : trustEntryFor(w) ?? w)))].slice(0, 4).join(' ')}`
        : '')
    );
  };

  for (const f of configuredFolders(ctx.dir)) {
    await run('folder', async () => {
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

  if (has('GOOGLE_SERVICE_ACCOUNT_KEY')) {
    await run('drive', async () => driveSummary(await checkDriveCredentials(env.GOOGLE_SERVICE_ACCOUNT_KEY!, 'GOOGLE_SERVICE_ACCOUNT_KEY', { apiBase: ctx.endpoints?.drive })));
  } else if (has('GOOGLE_APPLICATION_CREDENTIALS')) {
    await run('drive', async () => driveSummary(await checkDrive(resolve(ctx.dir, env.GOOGLE_APPLICATION_CREDENTIALS!), { apiBase: ctx.endpoints?.drive })));
  } else ctx.out('· drive       not configured');

  if (has('OPENAI_API_KEY') || has('EMBEDDING_API_KEY') || has('EMBEDDING_BASE_URL')) {
    await run('embeddings', async () => {
      const r = await checkEmbedding({ baseUrl: env.EMBEDDING_BASE_URL, model: env.EMBEDDING_MODEL, apiKey: env.EMBEDDING_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() });
      const want = env.EMBEDDING_DIM?.trim() || (env.EMBEDDING_BASE_URL?.trim() ? '' : '1536');
      if (want && Number(want) !== r.dim && !/^text-embedding-3/.test(r.model)) {
        throw new Error(`${r.model} returns ${r.dim}-dimension vectors but EMBEDDING_DIM is ${want}. Set EMBEDDING_DIM=${r.dim} and reindex.`);
      }
      return `${r.model} (${r.dim} dimensions)`;
    });
  } else ctx.out('· embeddings  not configured (search works by keywords; an embedding model adds search by meaning)');

  if (has('SLACK_BOT_TOKEN')) await run('slack', async () => { const r = await checkSlack(env.SLACK_BOT_TOKEN!.trim(), { apiBase: ctx.endpoints?.slack }); return `${r.team} as ${r.user}`; });
  else ctx.out('· slack       not configured');

  const gh = env.GITHUB_PAT?.trim() || env.GITHUB_TOKEN?.trim();
  if (gh) await run('github', async () => `signed in as ${(await checkGithub(gh, { apiBase: ctx.endpoints?.github })).login}`);
  else ctx.out('· github      not configured');

  if (has('RAILWAY_TOKEN')) await run('railway', async () => (await checkRailway(env.RAILWAY_TOKEN!.trim(), { apiBase: ctx.endpoints?.railway })).who);
  else ctx.out('· railway     not configured');

  if (checked === 0) ctx.out('Nothing is configured yet. Run `knowledge-mcp setup`.');
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
      ctx.out(`  Ask the person whether these are theirs, then run: knowledge-mcp setup trust ${untrusted.join(' ')}`);
    }
    return 0;
  }
  if (!values.gcloud) throw new Error('setup drive needs --gcloud or --key <file>');

  if (!hasTool(exec, 'gcloud')) {
    ctx.out('✗ The gcloud CLI is not installed. Install it (https://cloud.google.com/sdk/docs/install), then run this again.');
    return 1;
  }
  const account = gcloudAccount(exec);
  if (!account) {
    ctx.out('✗ gcloud is not signed in. The person who owns the Google account must run this in a terminal (it opens a browser):');
    ctx.out('    gcloud auth login');
    return 1;
  }
  const project = values.project ?? gcloudDefaultProject(exec);
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
  const r = createDriveServiceAccount(exec, plan);
  updateEnvFile(envPath, { GOOGLE_APPLICATION_CREDENTIALS: plan.keyPath });
  ctx.out(`✓ ${r.created ? 'Created' : 'Reused'} ${r.email}. Key saved to ${plan.keyPath}, path saved to ${envPath}.`);
  // A key that was created a moment ago can be refused for a few seconds.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const d = await checkDrive(plan.keyPath, { apiBase: ctx.endpoints?.drive });
      ctx.out(`✓ The key works. ${d.shared.length} item${d.shared.length === 1 ? '' : 's'} shared with it so far.`);
      break;
    } catch (e) {
      if (attempt === 6) ctx.out(`· The key is saved but does not answer yet (${msg(e)}). Run \`knowledge-mcp setup check\` in a minute.`);
      else await new Promise((res) => setTimeout(res, ctx.retryDelayMs ?? 4000));
    }
  }
  const own = trustEntryFor(account);
  if (own && addTrusted(ctx.dir, [own]).length) ctx.out(`✓ Documents owned by ${own} are trusted (the account that created this). Add others with: knowledge-mcp setup trust <email-or-domain>`);
  ctx.out(`Next: share a Drive folder or document with ${r.email} (Viewer). search_drive sees it at once; search_knowledge after the next sync.`);
  return 0;
}

async function github(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'from-gh': { type: 'boolean' } } });
  if (!values['from-gh']) throw new Error('setup github needs --from-gh (a token you type goes through `knowledge-mcp setup`)');
  const exec = ctx.exec ?? systemExec;
  const token = hasTool(exec, 'gh') ? ghToken(exec) : null;
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
  } catch (e) {
    ctx.out(`✗ ${msg(e)}`);
    return 1;
  }
  ctx.out(`usage: knowledge-mcp ${SETUP_USAGE}`);
  return 2;
}
