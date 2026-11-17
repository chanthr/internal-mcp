/**
 * `knowledge-mcp setup` — the guided setup.
 *
 * The goal: nobody edits .env or mcp.config.json by hand. The wizard asks which services to connect, checks every
 * value against the real service the moment it is entered, writes the two files, registers the first admin and
 * prints (or runs) the command that connects an AI client. It can be run again at any time: what is already set
 * is shown and kept unless changed.
 *
 * All prompts go through `SetupIO`, so tests drive the whole flow with scripted answers and fake services.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDrive, checkEmbedding, checkGithub, checkRailway, checkSlack, type DriveCheck } from './checks.js';
import {
  createDriveServiceAccount,
  gcloudAccount,
  gcloudDefaultProject,
  gcloudProjects,
  ghToken,
  hasTool,
  serviceAccountCommands,
  serviceAccountEmail,
  systemExec,
  type Exec,
} from './auto.js';
import { isTrusted, trustEntryFor, validTrustEntry } from '../plugins/drive/trust.js';
import { readEnvKeys, updateEnvFile } from './envfile.js';

export interface SetupIO {
  /** Print a line. */
  say(line?: string): void;
  /** Ask a question. Returns the trimmed answer, or `fallback` when the answer is empty. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Ask for a secret. The answer is not echoed. */
  secret(question: string): Promise<string>;
}

export interface SetupOptions {
  /** Folder that holds .env and mcp.config.json. Default: the working directory. */
  dir?: string;
  /** Overrides for tests: base URLs of the services, and how the admin key is created. */
  endpoints?: { drive?: string; slack?: string; github?: string; railway?: string };
  createAdmin?: (email: string) => Promise<{ key: string; existed: boolean }>;
  /** How the server is started, for the client command. Default: this package's own binary. */
  serveCommand?: string[];
  /** Run `claude mcp add` when the user agrees. Tests turn this off. */
  canRunClient?: boolean;
  /** Runs the gcloud and gh CLIs. Tests pass a fake. */
  exec?: Exec;
  /** Pause between attempts while a new key becomes valid. Tests set 0. */
  retryDelayMs?: number;
}

export interface SetupResult {
  envWritten: string[];
  configWritten: boolean;
  connected: string[];
  adminEmail: string | null;
}

const CONNECTORS = [
  { id: 'drive', label: 'Google Drive', hint: 'search and read documents shared with a service account' },
  { id: 'slack', label: 'Slack', hint: 'read channels and search messages' },
  { id: 'github', label: 'GitHub', hint: 'read repositories' },
  { id: 'railway', label: 'Railway', hint: 'deployments and logs' },
] as const;
type ConnectorId = (typeof CONNECTORS)[number]['id'];

const ENV_OF: Record<ConnectorId, string[]> = {
  drive: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
  slack: ['SLACK_BOT_TOKEN'],
  github: ['GITHUB_PAT', 'GITHUB_TOKEN'],
  railway: ['RAILWAY_TOKEN'],
};

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());

const COUNT_CAP = 5000;
const DOCUMENT = /\.(md|markdown|mdx|txt|pdf|docx|pptx|xlsx)$/i;

/** How many indexable documents a folder holds, for the confirmation line. Stops counting at COUNT_CAP. */
export function countDocuments(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number): void => {
    if (n >= COUNT_CAP || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= COUNT_CAP) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(join(d, e.name), depth + 1);
      else if (e.isFile() && DOCUMENT.test(e.name)) n++;
    }
  };
  walk(dir, 0);
  return n;
}

/** "1,3" or "drive slack" → connector ids. Unknown entries are ignored. */
export function parseSelection(answer: string): ConnectorId[] {
  const out: ConnectorId[] = [];
  for (const part of answer.split(/[\s,]+/).filter(Boolean)) {
    const byNumber = /^\d+$/.test(part) ? CONNECTORS[Number(part) - 1] : undefined;
    const c = byNumber ?? CONNECTORS.find((x) => x.id === part.toLowerCase());
    if (c && !out.includes(c.id)) out.push(c.id);
  }
  return out;
}

/** Ask until the check passes or the user gives up (empty answer). Returns the accepted value, or null. */
async function askChecked<T>(
  io: SetupIO,
  prompt: () => Promise<string>,
  check: (value: string) => Promise<T>,
  ok: (found: T) => string,
): Promise<{ value: string; found: T } | null> {
  for (;;) {
    const value = await prompt();
    if (!value) return null;
    try {
      const found = await check(value);
      io.say(`  ✓ ${ok(found)}`);
      return { value, found };
    } catch (e) {
      io.say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
      io.say('    Try again, or press Enter to skip this one.');
    }
  }
}

function readConfig(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}). Fix or remove it, then run setup again.`);
  }
}

/**
 * Create the Drive service account and key with the signed-in gcloud CLI. Shows the exact commands and asks before
 * anything is created in the user's cloud project. Returns the key path, or null when the user backs out or a step
 * fails (the caller then falls back to asking for a key file).
 */
async function driveKeyWithGcloud(io: SetupIO, exec: Exec, dir: string): Promise<string | null> {
  let account = gcloudAccount(exec);
  if (!account) {
    io.say('  gcloud is not signed in. In another terminal run:  gcloud auth login');
    await io.ask('  Press Enter when you are signed in (or Enter now to use a key file instead):', '');
    account = gcloudAccount(exec);
    if (!account) return null;
  }
  io.say(`  Signed in to Google Cloud as ${account}.`);
  let projects;
  try {
    projects = gcloudProjects(exec);
  } catch (e) {
    io.say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (projects.length === 0) {
    io.say('  This account has no Google Cloud project. Create one first:  gcloud projects create <id>');
    return null;
  }
  const preset = gcloudDefaultProject(exec);
  const shown = projects.slice(0, 15);
  io.say('  Which project should hold the service account?');
  shown.forEach((p, i) => io.say(`    ${i + 1}. ${p.id}${p.name !== p.id ? `  (${p.name})` : ''}${p.id === preset ? '  [current]' : ''}`));
  if (projects.length > shown.length) io.say(`    … ${projects.length - shown.length} more: type the project id`);
  const fallback = preset && projects.some((p) => p.id === preset) ? preset : shown[0].id;
  const answer = await io.ask(`  Number or project id (Enter for ${fallback}):`, fallback);
  const project = /^\d+$/.test(answer) ? shown[Number(answer) - 1]?.id : projects.find((p) => p.id === answer)?.id;
  if (!project) {
    io.say('  ✗ That is not one of the projects.');
    return null;
  }
  const plan = { project, name: 'knowledge-mcp-drive', keyPath: join(dir, 'drive-service-account.json') };
  io.say('  This will run:');
  for (const c of serviceAccountCommands(plan)) io.say(`    ${c.join(' ')}`);
  io.say(`  The account ${serviceAccountEmail(plan)} gets no project role. It can only read what you share with it in Drive.`);
  if (!yes(await io.ask('  Create it now? (y/N)', 'n'))) return null;
  try {
    const r = createDriveServiceAccount(exec, plan);
    io.say(`  ✓ ${r.created ? 'Created' : 'Reused'} ${r.email}, key saved to ${plan.keyPath}`);
    return plan.keyPath;
  } catch (e) {
    io.say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function runSetup(io: SetupIO, opts: SetupOptions = {}): Promise<SetupResult> {
  const dir = resolve(opts.dir ?? process.cwd());
  const envPath = join(dir, '.env');
  const configPath = join(dir, 'mcp.config.json');
  const already = readEnvKeys(envPath);
  const isSet = (id: ConnectorId) => ENV_OF[id].some((k) => already.has(k) || !!process.env[k]?.trim());

  const env: Record<string, string | undefined> = {};
  const config = readConfig(configPath);
  let configChanged = false;
  const connected: string[] = [];

  io.say('Knowledge MCP setup');
  io.say(`Files: ${envPath} (secrets) and ${configPath} (what to look at).`);
  io.say('Every value is checked against the real service before it is saved. Press Enter to skip a question.');
  io.say();
  // ── Documents on this machine ──
  const currentFolders: Array<{ path: string }> = Array.isArray(config.folders) ? config.folders : [];
  io.say('Documents on this machine');
  io.say('  A folder of documents (Markdown, text, PDF, Word, PowerPoint, Excel) is searchable right away: no account, no key.');
  if (currentFolders.length) io.say(`  Indexed now: ${currentFolders.map((f) => f.path).join(', ')}`);
  for (;;) {
    const answer = await io.ask(`  Folder path (Enter to ${currentFolders.length ? 'keep the list' : 'skip'}):`, '');
    if (!answer) break;
    const path = resolve(dir, answer.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ').replace(/^~(?=$|\/)/, homedir()));
    let count: number | null = null;
    try {
      if (statSync(path).isDirectory()) count = countDocuments(path);
    } catch {
      /* does not exist */
    }
    if (count === null) {
      io.say(`  ✗ ${path} is not a folder. Try again, or press Enter to skip.`);
      continue;
    }
    if (!currentFolders.some((f) => resolve(dir, f.path) === path)) {
      currentFolders.push({ path });
      config.folders = currentFolders;
      configChanged = true;
    }
    connected.push('local folder');
    io.say(`  ✓ ${path}: ${count >= COUNT_CAP ? `${COUNT_CAP}+` : count} document${count === 1 ? '' : 's'} to index`);
    break;
  }
  io.say();
  io.say('Which services do you want to connect?');
  CONNECTORS.forEach((c, i) => io.say(`  ${i + 1}. ${c.label.padEnd(13)} ${c.hint}${isSet(c.id) ? '  (already set)' : ''}`));
  const picked = parseSelection(await io.ask('Numbers, separated by commas (Enter for none):', ''));

  // ── Google Drive ──
  if (picked.includes('drive')) {
    io.say();
    io.say('Google Drive');
    io.say('  You need a service account key file (JSON). In Google Cloud: IAM & Admin → Service Accounts → create one →');
    io.say('  Keys → Add key → JSON. Also enable the "Google Drive API" for that project.');
    const exec = opts.exec ?? systemExec;
    let keyPath: string | null = null;
    let found: DriveCheck | null = null;
    let gcloudUser: string | null = null;
    if (hasTool(exec, 'gcloud')) {
      io.say('  The gcloud CLI is installed, so this can be done for you:');
      io.say('    1. Create the service account and key with gcloud (you only sign in)');
      io.say('    2. I already have a key file');
      if ((await io.ask('  Choose 1 or 2:', '1')) === '1') {
        keyPath = await driveKeyWithGcloud(io, exec, dir);
        if (keyPath) gcloudUser = gcloudAccount(exec);
      }
    } else {
      io.say('  Tip: with the gcloud CLI installed (cloud.google.com/sdk), setup can create the key for you.');
    }
    if (keyPath) {
      // A key that was created a moment ago can be refused for a few seconds.
      for (let attempt = 1; ; attempt++) {
        try {
          found = await checkDrive(keyPath, { apiBase: opts.endpoints?.drive });
          io.say(`  ✓ signed in as ${found.email}`);
          break;
        } catch (e) {
          if (attempt >= 6) {
            io.say(`  ✗ The new key does not work yet: ${e instanceof Error ? e.message : String(e)}`);
            io.say('    It is saved. Run `knowledge-mcp setup check` in a minute.');
            break;
          }
          await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 4000));
        }
      }
    } else {
      const cleanPath = (p: string) => resolve(dir, p.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' '));
      const got = await askChecked(
        io,
        () => io.ask('  Path to the key file (you can drag the file into the terminal):', ''),
        (p) => checkDrive(cleanPath(p), { apiBase: opts.endpoints?.drive }),
        (d) => (d.email ? `signed in as ${d.email}` : 'signed in with a refresh token'),
      );
      if (got) {
        keyPath = cleanPath(got.value);
        found = got.found;
      }
    }
    if (keyPath) {
      env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
      connected.push('drive');
    }
    if (keyPath && found) {
      const { shared, more, email } = found;
      if (shared.length === 0) {
        io.say('  Nothing is shared with this account yet.');
        if (email) io.say(`  Share a folder or a document with ${email} (Viewer) and it becomes searchable. No restart needed.`);
      } else {
        io.say(`  It can see ${shared.length}${more ? '+' : ''} shared item${shared.length === 1 ? '' : 's'}:`);
        for (const s of shared.slice(0, 8)) io.say(`    ${s.folder ? '[folder]' : '[file]  '} ${s.name}`);
        if (shared.length > 8 || more) io.say('    …');
        if (email) io.say(`  To add more, share them with ${email}.`);
      }

      // Whose documents are shown. Sharing with the account needs no acceptance, so without this anyone who learns
      // its address could plant a document in every user's search results.
      const trusted: string[] = Array.isArray(config.drive?.trustedOwners) ? [...config.drive.trustedOwners] : [];
      // How many shared items each owner accounts for, as trust entries (a domain, or one address at a public mail provider).
      const byOwner = new Map<string, string[]>();
      for (const item of shared) {
        for (const entry of new Set(item.owners.map(trustEntryFor).filter((e): e is string => !!e))) {
          byOwner.set(entry, [...(byOwner.get(entry) ?? []), item.name]);
        }
      }
      io.say();
      io.say('  Anyone who knows this account\'s address can share a document with it. So only documents from owners you');
      io.say(`  trust are shown.${trusted.length ? ` Trusted now: ${trusted.join(', ')}.` : ''}`);
      // A default is offered only for the signed-in Google Cloud account, which is known to be the person at the
      // keyboard. Nothing is guessed from what happens to be shared: a planted document must never become trusted by
      // pressing Enter. Every other owner has to be typed.
      const own = gcloudUser ? trustEntryFor(gcloudUser) : null;
      if (!own || !trusted.includes(own)) {
        const answer = await io.ask(
          `  Your organization's domain, or your own address${own ? ` (Enter for ${own}, "-" for none)` : trusted.length ? ' (Enter to keep the list)' : ' (Enter for none)'}:`,
          own ?? '',
        );
        if (answer && answer !== '-') {
          const ok = validTrustEntry(answer);
          if (ok !== true) io.say(`  ✗ ${ok}`);
          else if (!trusted.includes(answer.toLowerCase())) trusted.push(answer.toLowerCase());
        }
      }
      const others = [...byOwner].filter(([entry]) => !trusted.includes(entry));
      if (others.length) {
        io.say('  Also shared with this account by:');
        for (const [entry, names] of others.slice(0, 8)) io.say(`    ${entry} — ${names.length} item${names.length === 1 ? '' : 's'} (${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''})`);
      }
      const extra = await io.ask('  Other owners to trust: emails or domains, separated by commas (Enter for none):', '');
      for (const entry of extra.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        const ok = validTrustEntry(entry);
        if (ok !== true) io.say(`  ✗ ${ok}`);
        else if (!trusted.includes(entry)) trusted.push(entry);
      }
      if (trusted.length !== (config.drive?.trustedOwners?.length ?? 0)) {
        config.drive = { ...(config.drive ?? {}), trustedOwners: trusted };
        configChanged = true;
      }
      const hidden = shared.filter((s) => !isTrusted(trusted, s.owners, s.driveId));
      if (trusted.length === 0) io.say('  No owner is trusted, so shared documents stay hidden. Add one later: knowledge-mcp setup trust <email-or-domain>');
      else if (hidden.length) io.say(`  ${hidden.length} shared item${hidden.length === 1 ? ' stays' : 's stay'} hidden (owner not trusted): ${hidden.slice(0, 3).map((h) => h.name).join(', ')}${hidden.length > 3 ? ' …' : ''}`);
      const current: string[] = Array.isArray(config.drive?.excludeFolders) ? config.drive.excludeFolders : [];
      const ex = await io.ask(
        `  Folder names to keep out of search, separated by commas, e.g. HR, Contracts${current.length ? ` (now: ${current.join(', ')})` : ''}:`,
        '',
      );
      if (ex) {
        const names = [...new Set([...current, ...ex.split(',').map((s) => s.trim()).filter(Boolean)])];
        config.drive = { ...(config.drive ?? {}), excludeFolders: names };
        configChanged = true;
      }

    }
  }

  // ── Slack ──
  if (picked.includes('slack')) {
    io.say();
    io.say('Slack');
    io.say('  You need a bot token (xoxb-…): api.slack.com/apps → your app → OAuth & Permissions. The bot only sees');
    io.say('  channels it was invited to.');
    const got = await askChecked(
      io,
      () => io.secret('  Bot token:'),
      (t) => checkSlack(t, { apiBase: opts.endpoints?.slack }),
      (r) => `${r.team} as ${r.user}${r.kind === 'user' ? ' (this is a user token; a bot token is recommended)' : ''}`,
    );
    if (got) {
      env.SLACK_BOT_TOKEN = got.value;
      connected.push('slack');
      const user = await askChecked(
        io,
        () => io.secret('  User token for message search, xoxp-… (Enter to skip):'),
        (t) => checkSlack(t, { apiBase: opts.endpoints?.slack }),
        (r) => `search as ${r.user}`,
      );
      if (user) env.SLACK_USER_TOKEN = user.value;
    }
  }

  // ── GitHub ──
  if (picked.includes('github')) {
    io.say();
    io.say('GitHub');
    const exec = opts.exec ?? systemExec;
    let fromGh: string | null = null;
    const gh = hasTool(exec, 'gh') ? ghToken(exec) : null;
    if (gh) {
      io.say('  The gh CLI is signed in. Its token can be reused, but it can do everything your gh login can (including');
      io.say('  writing). This server only reads, yet a fine-grained read-only token is the safer choice.');
      if (yes(await io.ask('  Use the gh login? (y/N)', 'n'))) {
        try {
          const r = await checkGithub(gh, { apiBase: opts.endpoints?.github });
          io.say(`  ✓ signed in as ${r.login}`);
          fromGh = gh;
        } catch (e) {
          io.say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (!fromGh) io.say('  You need a token with read access to the repositories (fine-grained: Contents → Read-only).');
    const got = fromGh ? { value: fromGh } : await askChecked(
      io,
      () => io.secret('  Token:'),
      (t) => checkGithub(t, { apiBase: opts.endpoints?.github }),
      (r) => `signed in as ${r.login}`,
    );
    if (got) {
      env.GITHUB_PAT = got.value;
      connected.push('github');
    }
  }

  // ── Railway ──
  if (picked.includes('railway')) {
    io.say();
    io.say('Railway');
    const got = await askChecked(
      io,
      () => io.secret('  API token (railway.com → Account Settings → Tokens):'),
      (t) => checkRailway(t, { apiBase: opts.endpoints?.railway }),
      (r) => r.who,
    );
    if (got) {
      env.RAILWAY_TOKEN = got.value;
      connected.push('railway');
    }
  }

  // ── Search by meaning: asked once there is something to search ──
  // Also on a later run, when the folder or Drive was set up before: this is where a model is added afterwards.
  if (currentFolders.length > 0 || connected.includes('drive') || isSet('drive')) {
  io.say();
  io.say('Search by meaning (optional)');
  io.say('  Search already works by keywords, with nothing to set up. An embedding model also finds documents that use');
  io.say('  different words than the question. It can be added later: documents are not read again.');
  io.say('    1. OpenAI (needs an API key)');
  io.say('    2. Another OpenAI-compatible endpoint (a local model through Ollama, or another provider)');
  io.say('    3. Not now');
  const choice = await io.ask('  Choose 1, 2 or 3:', '3');
  if (choice === '1') {
    const key = await askChecked(
      io,
      () => io.secret('  OpenAI API key:'),
      (k) => checkEmbedding({ apiKey: k }),
      (r) => `${r.model} answers (${r.dim} dimensions)`,
    );
    if (key) {
      env.OPENAI_API_KEY = key.value;
      env.EMBEDDING_BASE_URL = undefined;
      env.EMBEDDING_MODEL = undefined;
      env.EMBEDDING_DIM = undefined;
      connected.push('search by meaning');
    }
  } else if (choice === '2') {
    const baseUrl = await io.ask('  Base URL (Ollama: http://localhost:11434/v1):', 'http://localhost:11434/v1');
    const model = await io.ask('  Model name:', 'bge-m3');
    const apiKey = await io.secret('  API key (Enter if the server needs none):');
    try {
      const r = await checkEmbedding({ baseUrl, model, apiKey: apiKey || undefined });
      io.say(`  ✓ ${r.model} answers (${r.dim} dimensions)`);
      env.EMBEDDING_BASE_URL = baseUrl;
      env.EMBEDDING_MODEL = model;
      env.EMBEDDING_DIM = String(r.dim); // read from the answer, so nobody has to look it up
      if (apiKey) env.EMBEDDING_API_KEY = apiKey;
      connected.push('search by meaning');
    } catch (e) {
      io.say(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
      io.say('    Skipped. Run setup again when the endpoint is up.');
    }
  }
  }

  // ── Write the files ──
  io.say();
  const envWritten = Object.keys(env).length ? updateEnvFile(envPath, env) : [];
  if (envWritten.length) io.say(`Saved ${envWritten.length} value${envWritten.length === 1 ? '' : 's'} to ${envPath} (${envWritten.join(', ')}).`);
  if (configChanged) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    io.say(`Saved ${configPath}.`);
  }
  if (!envWritten.length && !configChanged) io.say('Nothing to save.');

  // ── First admin ──
  let adminEmail: string | null = null;
  if (opts.createAdmin) {
    io.say();
    io.say('Who is the admin? Other people and remote clients sign in with a key. Running locally needs none.');
    const email = (await io.ask('  Your email (Enter to skip):', '')).toLowerCase();
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        io.say('  ✗ That does not look like an email address. Skipped: run `knowledge-mcp keys create --email you@example.com --role admin` later.');
      } else {
        const { key, existed } = await opts.createAdmin(email);
        adminEmail = email;
        io.say(`  ✓ ${existed ? `${email} is already registered` : `${email} is the admin`}. A new API key (shown once, copy it now):`);
        io.say(`    ${key}`);
      }
    }
  }

  // ── Connect a client ──
  io.say();
  io.say('Connect an AI client');
  const serve = opts.serveCommand ?? ['npx', 'knowledge-mcp', 'serve', '--stdio'];
  const name = String(config.branding?.name ?? 'knowledge').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'knowledge';
  const addArgs = ['mcp', 'add', name, '--', ...serve];
  io.say(`  Claude Code (this machine):  claude ${addArgs.join(' ')}`);
  io.say('  Any client over HTTP:        start the server, then use http://localhost:8080/mcp with header "Authorization: Bearer <key>"');
  if (opts.canRunClient !== false && spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0) {
    if (yes(await io.ask('  Claude Code is installed. Add this server to it now? (y/N)', 'n'))) {
      const r = spawnSync('claude', addArgs, { cwd: dir, stdio: 'inherit' });
      io.say(r.status === 0 ? '  ✓ Added. Start a new Claude Code session to use it.' : '  ✗ `claude mcp add` failed. Run the command above yourself.');
    }
  }

  io.say();
  io.say(connected.length ? `Connected: ${connected.join(', ')}.` : 'No service connected yet. Run `knowledge-mcp setup` again any time.');
  if (currentFolders.length > 0 || connected.includes('drive')) io.say('The server builds the search index by itself and keeps it up to date.');
  io.say('Check the result with `knowledge-mcp doctor`. Start the server with `knowledge-mcp serve`.');
  return { envWritten, configWritten: configChanged, connected, adminEmail };
}
