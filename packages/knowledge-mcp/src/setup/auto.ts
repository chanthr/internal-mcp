/**
 * Setup steps that use a login the user already has, instead of asking them to click through a web console.
 *
 *   - Google Drive: with the gcloud CLI signed in, create the service account, enable the Drive API and download a
 *     key. The user only signs in once in the browser (`gcloud auth login`).
 *   - GitHub: with the gh CLI signed in, reuse its token.
 *
 * Commands run through `Exec`, so tests replace the real CLIs with a script. Nothing here prints a secret: the key
 * goes to a file, and the GitHub token is returned to the caller, which writes it to .env.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => ExecResult;

export const systemExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Is the command installed? */
export function hasTool(exec: Exec, cmd: string): boolean {
  return exec(cmd, ['--version']).status === 0;
}

// ── Google Cloud ──

/** The account gcloud is signed in with, or null. */
export function gcloudAccount(exec: Exec): string | null {
  const r = exec('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  const account = r.stdout.trim().split('\n')[0]?.trim();
  return r.status === 0 && account ? account : null;
}

export interface GcloudProject {
  id: string;
  name: string;
}

/** Projects the account can see. Throws when the login has expired, with the command that fixes it. */
export function gcloudProjects(exec: Exec): GcloudProject[] {
  const r = exec('gcloud', ['projects', 'list', '--format=json(projectId,name)', '--sort-by=projectId']);
  if (r.status !== 0) {
    if (/reauth|login|credential/i.test(r.stderr)) throw new Error('gcloud needs a fresh sign-in. Run: gcloud auth login');
    throw new Error(`gcloud projects list failed: ${lastLine(r.stderr)}`);
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
export function gcloudDefaultProject(exec: Exec): string | null {
  const r = exec('gcloud', ['config', 'get-value', 'project']);
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
export function createDriveServiceAccount(exec: Exec, plan: ServiceAccountPlan): { email: string; created: boolean } {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(plan.name)) {
    throw new Error(`service account name "${plan.name}" must be 6-30 characters: lowercase letters, digits and dashes`);
  }
  if (existsSync(plan.keyPath)) throw new Error(`${plan.keyPath} already exists. Remove it or choose another path, so an existing key is not overwritten.`);
  const email = serviceAccountEmail(plan);
  const [enable, create, key] = serviceAccountCommands(plan);

  const en = exec(enable[0], enable.slice(1));
  if (en.status !== 0) {
    if (/billing/i.test(en.stderr)) throw new Error(`Could not enable the Drive API in ${plan.project}: the project has no billing account. Pick another project, or link billing.`);
    if (/PERMISSION_DENIED|does not have permission/i.test(en.stderr)) throw new Error(`Could not enable the Drive API in ${plan.project}: your account lacks permission (needs Service Usage Admin or Owner).`);
    throw new Error(`Could not enable the Drive API in ${plan.project}: ${lastLine(en.stderr)}`);
  }

  const exists = exec('gcloud', ['iam', 'service-accounts', 'describe', email, `--project=${plan.project}`, '--format=value(email)']).status === 0;
  if (!exists) {
    const cr = exec(create[0], create.slice(1));
    if (cr.status !== 0) throw new Error(`Could not create the service account: ${lastLine(cr.stderr)}`);
  }

  const k = exec(key[0], key.slice(1));
  if (k.status !== 0) {
    if (/disableServiceAccountKeyCreation|Key creation is not allowed/i.test(k.stderr)) {
      throw new Error(
        `Your organization blocks service account keys (policy iam.disableServiceAccountKeyCreation). ` +
          `Ask an admin to allow it for project ${plan.project}, or use a project outside the organization. The account ${email} was ${exists ? 'left as it is' : 'created'}.`,
      );
    }
    throw new Error(`Could not create a key for ${email}: ${lastLine(k.stderr)}`);
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
export function ghToken(exec: Exec): string | null {
  const r = exec('gh', ['auth', 'token']);
  const token = r.stdout.trim();
  return r.status === 0 && token ? token : null;
}
