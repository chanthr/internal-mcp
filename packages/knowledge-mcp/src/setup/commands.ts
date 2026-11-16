/**
 * Setup commands that ask no questions, for scripts and for AI agents that set the server up on someone's behalf.
 *
 *   knowledge-mcp setup check                          verify every configured service live, exit 1 on a failure
 *   knowledge-mcp setup drive --gcloud [--project ID] [--yes]
 *                                                      create the Drive service account and key with gcloud
 *   knowledge-mcp setup drive --key <file>             use an existing key file
 *   knowledge-mcp setup github --from-gh               reuse the gh CLI login
 *   knowledge-mcp setup embeddings --base-url URL --model NAME
 *                                                      a keyless OpenAI-compatible endpoint (a local model)
 *
 * Secrets are never taken as arguments: an argument ends up in shell history and in an agent's transcript.
 * A key that has to be typed (OpenAI, Slack, a GitHub token) goes through the interactive `knowledge-mcp setup`,
 * or straight into .env by the person who owns it. `setup check` then tells whether it works.
 */
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { checkDrive, checkDriveCredentials, checkEmbedding, checkGithub, checkRailway, checkSlack } from './checks.js';
import { updateEnvFile } from './envfile.js';
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
       setup drive --gcloud [--project ID] [--yes]
       setup drive --key <file>
       setup github --from-gh
       setup embeddings --base-url URL --model NAME`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const driveSummary = (d: Awaited<ReturnType<typeof checkDrive>>) =>
    `${d.email ?? 'refresh token'} — ${d.shared.length}${d.more ? '+' : ''} shared item${d.shared.length === 1 ? '' : 's'}` +
    (d.shared.length === 0 && d.email ? `. Share a folder or document with ${d.email} to make it searchable` : '');

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
  } else ctx.out('· embeddings  not configured (semantic search is off; keyword search and reading work)');

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
  ctx.out(`Next: share a Drive folder or document with ${r.email} (Viewer). It becomes searchable without a restart.`);
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
    if (sub === 'github') return await github(rest, ctx);
    if (sub === 'embeddings') return await embeddings(rest, ctx);
  } catch (e) {
    ctx.out(`✗ ${msg(e)}`);
    return 1;
  }
  ctx.out(`usage: knowledge-mcp ${SETUP_USAGE}`);
  return 2;
}
