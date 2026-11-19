/**
 * Setup steps that use a login the user already has, instead of asking them to click through a web console.
 *
 *   - Google Drive: with the gcloud CLI signed in, create the service account, enable the Drive API and download a
 *     key. The user only signs in once in the browser (`gcloud auth login`).
 *   - GitHub: with the gh CLI signed in, reuse its token.
 *
 * Commands run through `Exec`, so tests replace the real CLIs with a script. Nothing here prints a secret: the key
 * goes to a file, and the GitHub token is returned to the caller, which writes it to .env.
 *
 * Every step awaits its command. A command line waits for each one (`systemExec`); the server does not stop
 * answering while gcloud works, which can take half a minute (`backgroundExec`).
 */
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => ExecResult | Promise<ExecResult>;
/** A command that is waited for on the spot (a quick one, in code that is not async). */
export type SyncExec = (cmd: string, args: string[]) => ExecResult;

export const systemExec: SyncExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The same, without holding up the process that asks: for a server that has other requests to answer. */
export const backgroundExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: 0, stdout, stderr });
      const code = (error as { code?: unknown }).code;
      // A number is the command's own exit code. Anything else (ENOENT, a timeout) means it did not run to an end.
      resolve({ status: typeof code === 'number' ? code : 127, stdout: stdout ?? '', stderr: stderr || error.message });
    });
  });

/** Is the command installed? */
export async function hasTool(exec: Exec, cmd: string): Promise<boolean> {
  return (await exec(cmd, ['--version'])).status === 0;
}

// ── Google Cloud ──

/** The account gcloud is signed in with, or null. */
export async function gcloudAccount(exec: Exec): Promise<string | null> {
  const r = await exec('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  const account = r.stdout.trim().split('\n')[0]?.trim();
  return r.status === 0 && account ? account : null;
}

export interface GcloudProject {
  id: string;
  name: string;
}

/**
 * gcloud wants the person to sign in again. Seen with an organization account: Google asks for the sign-in again
 * after a while, gcloud would ask for it in the terminal, and run from here it has no terminal to ask in
 * ("Reauthentication failed. cannot prompt during non-interactive execution"). Every gcloud step can end this way,
 * so every step says the same thing about it: what to run, not gcloud's sentence.
 */
const signInExpired = (stderr: string): boolean => /reauth|gcloud auth login|refreshing your current auth tokens|cannot prompt during non-interactive|invalid_grant/i.test(stderr);
export const GCLOUD_SIGN_IN = "gcloud's sign-in has expired, and gcloud cannot ask for it again from here. Run this in a terminal, then try again: gcloud auth login";
const gcloudFailed = (what: string, stderr: string): Error => new Error(signInExpired(stderr) ? GCLOUD_SIGN_IN : `${what}: ${lastLine(stderr)}`);

/** Projects the account can see. Throws when the login has expired, with the command that fixes it. */
export async function gcloudProjects(exec: Exec): Promise<GcloudProject[]> {
  const r = await exec('gcloud', ['projects', 'list', '--format=json(projectId,name)', '--sort-by=projectId']);
  if (r.status !== 0) {
    if (/credential/i.test(r.stderr)) throw new Error(GCLOUD_SIGN_IN);
    throw gcloudFailed('gcloud projects list failed', r.stderr);
  }
  try {
    return (JSON.parse(r.stdout || '[]') as Array<{ projectId?: string; name?: string }>)
      .filter((p) => p.projectId)
      .map((p) => ({ id: p.projectId!, name: p.name ?? p.projectId! }));
  } catch {
    throw new Error('gcloud projects list returned something that is not JSON');
  }
}

/** The project gcloud is set to, or null. */
export async function gcloudDefaultProject(exec: Exec): Promise<string | null> {
  const r = await exec('gcloud', ['config', 'get-value', 'project']);
  const p = r.stdout.trim();
  return r.status === 0 && p && p !== '(unset)' ? p : null;
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n').filter((l) => l.trim());
  // gcloud puts the reason on an "ERROR:" line; later lines are often generic hints.
  return (lines.find((l) => l.startsWith('ERROR:')) ?? lines[lines.length - 1] ?? 'no output').slice(0, 300);
}

export interface ServiceAccountPlan {
  project: string;
  /** Account id: 6-30 characters, lowercase letters, digits and dashes. */
  name: string;
  /** Where the key file is written. */
  keyPath: string;
}

export function serviceAccountEmail(plan: Pick<ServiceAccountPlan, 'project' | 'name'>): string {
  return `${plan.name}@${plan.project}.iam.gserviceaccount.com`;
}

/** The gcloud commands that `createDriveServiceAccount` runs, for showing to the user before they agree. */
export function serviceAccountCommands(plan: ServiceAccountPlan): string[][] {
  const email = serviceAccountEmail(plan);
  return [
    ['gcloud', 'services', 'enable', 'drive.googleapis.com', `--project=${plan.project}`],
    ['gcloud', 'iam', 'service-accounts', 'create', plan.name, '--display-name=Knowledge MCP (Drive read-only)', `--project=${plan.project}`],
    ['gcloud', 'iam', 'service-accounts', 'keys', 'create', plan.keyPath, `--iam-account=${email}`, `--project=${plan.project}`],
  ];
}

/**
 * Enable the Drive API, create the service account if it does not exist, and download a key.
 * The account gets no project role: it can only read what is shared with it in Drive.
 * Returns the address to share documents with.
 */
export async function createDriveServiceAccount(exec: Exec, plan: ServiceAccountPlan): Promise<{ email: string; created: boolean }> {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(plan.name)) {
    throw new Error(`service account name "${plan.name}" must be 6-30 characters: lowercase letters, digits and dashes`);
  }
  if (existsSync(plan.keyPath)) throw new Error(`${plan.keyPath} already exists. Remove it or choose another path, so an existing key is not overwritten.`);
  const email = serviceAccountEmail(plan);
  const [enable, create, key] = serviceAccountCommands(plan);

  const en = await exec(enable[0], enable.slice(1));
  if (en.status !== 0) {
    if (/billing/i.test(en.stderr)) throw new Error(`Could not enable the Drive API in ${plan.project}: the project has no billing account. Pick another project, or link billing.`);
    if (/PERMISSION_DENIED|does not have permission/i.test(en.stderr)) throw new Error(`Could not enable the Drive API in ${plan.project}: your account lacks permission (needs Service Usage Admin or Owner).`);
    throw gcloudFailed(`Could not enable the Drive API in ${plan.project}`, en.stderr);
  }

  const exists = (await exec('gcloud', ['iam', 'service-accounts', 'describe', email, `--project=${plan.project}`, '--format=value(email)'])).status === 0;
  if (!exists) {
    const cr = await exec(create[0], create.slice(1));
    if (cr.status !== 0) throw gcloudFailed('Could not create the service account', cr.stderr);
  }

  const k = await exec(key[0], key.slice(1));
  if (k.status !== 0) {
    if (/disableServiceAccountKeyCreation|Key creation is not allowed/i.test(k.stderr)) {
      throw new Error(
        `Your organization blocks service account keys (policy iam.disableServiceAccountKeyCreation). ` +
          `Ask an admin to allow it for project ${plan.project}, or use a project outside the organization. The account ${email} was ${exists ? 'left as it is' : 'created'}.`,
      );
    }
    throw gcloudFailed(`Could not create a key for ${email}`, k.stderr);
  }
  try {
    chmodSync(plan.keyPath, 0o600);
  } catch {
    /* the fake CLI in tests may not write the file */
  }
  return { email, created: !exists };
}

// ── GitHub ──

/** The token of the signed-in gh CLI, or null when gh is missing or signed out. */
export async function ghToken(exec: Exec): Promise<string | null> {
  const r = await exec('gh', ['auth', 'token']);
  const token = r.stdout.trim();
  return r.status === 0 && token ? token : null;
}
