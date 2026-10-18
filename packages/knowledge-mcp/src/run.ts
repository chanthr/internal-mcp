/**
 * run() — the command line of every Knowledge MCP server. The `knowledge-mcp` binary calls it with the
 * built-in plugins; your own server.ts calls it with yours, so every command below sees your plugins too.
 *
 *   serve [--stdio]                 start the server (HTTP by default, or stdio for local clients)
 *   keys create|list|revoke         API keys (only a hash is stored; the key is shown once)
 *   users add|list|remove           who is admin or member, and which plugins a member may use
 *   doctor                          config, store, OAuth and which plugins are on (and why not)
 *   <plugin> <command> [args]       commands a plugin adds, e.g. `drive reindex --dry-run`
 */
import { parseArgs } from 'node:util';
import { configSource, getConfig } from './core/config.js';
import { isOAuthConfigured, oauthAttempted, oauthConfigProblems, OAUTH_ISSUER_URL } from './core/oauth.js';
import { parseExpiry } from './store/keys.js';
import { getStore, storeKind } from './store/index.js';
import type { Role } from './core/auth.js';
import { VERSION } from './version.js';
import type { Plugin } from './plugin/define.js';
import { Registry } from './plugin/registry.js';
import { builtinPlugins } from './plugins/index.js';

export interface RunOptions {
  /** Plugins to serve. Default: the built-in Drive, Slack, GitHub and Railway plugins. */
  plugins?: Plugin[];
  /** Arguments without node and the script path. Default: process.argv.slice(2). */
  argv?: string[];
}

class UsageError extends Error {}

const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const info = (s = ''): void => void process.stderr.write(`${s}\n`);
const csvList = (v: string | undefined): string[] | null =>
  v === undefined ? null : v.split(',').map((x) => x.trim()).filter(Boolean);

function roleArg(v: string | undefined, allowed: Role[]): Role | undefined {
  if (v === undefined) return undefined;
  const r = v === 'engineer' ? 'member' : v;
  if (!allowed.includes(r as Role)) throw new UsageError(`--role must be one of ${allowed.join(', ')}`);
  return r as Role;
}

const HELP = `Knowledge MCP ${VERSION}

Usage: knowledge-mcp <command> [options]

  serve [--stdio]                     Start the server (HTTP on $PORT, default 8080)
  keys create [--email E] [--role R] [--label L] [--expires 90d]
                                      Create an API key and print it once
  keys list                           List keys (never the key itself)
  keys revoke <id>                    Deactivate a key
  users add <email> [--role admin|member] [--tools a,b] [--slack-channels C1,C2] [--drive-folders A/B]
                                      Register a person (members see every plugin unless --tools is set)
  users list | users remove <email>
  doctor                              Show config, store, OAuth and plugin status
  <plugin> <command> [args]           Run a plugin command (see doctor for the list)

Docs: https://github.com/chanthr/internal-mcp`;

async function cmdServe(registry: Registry, argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { stdio: { type: 'boolean' } }, allowPositionals: false });
  if (values.stdio) process.env.MCP_TRANSPORT = 'stdio';
  const transport = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
  if (transport === 'stdio') {
    const { runStdio } = await import('./server/stdio.js');
    await runStdio(registry);
  } else {
    const { runHttp } = await import('./server/http.js');
    await runHttp(registry);
  }
}

async function cmdKeys(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const store = await getStore();
  if (sub === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        email: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        expires: { type: 'string' },
        org: { type: 'string' },
      },
    });
    const role = roleArg(values.role, ['admin', 'member', 'viewer']);
    const email = values.email?.trim().toLowerCase();
    if (email) {
      // A key with an email takes that person's role from app_users, so --role is saved there.
      const existing = await store.getUser(email);
      if (role) {
        await store.upsertUser({ ...(existing ?? { email }), email, role: role === 'admin' ? 'admin' : 'member' });
        if (role === 'viewer') info(`note: viewer is the role of people without a users entry; saved ${email} as member.`);
      } else if (!existing) {
        info(`note: ${email} is not registered, so this key gets the viewer role (ping only).`);
        info(`      Run: knowledge-mcp users add ${email} --role member   (or pass --role to this command)`);
      }
    }
    const created = await store.createKey({
      email: email ?? null,
      role: email ? 'member' : (role ?? 'member'),
      orgId: values.org ?? getConfig().orgId,
      label: values.label ?? null,
      expiresAt: values.expires ? parseExpiry(values.expires) : null,
    });
    const who = email ? `${email}, role from users` : `service key, role ${role ?? 'member'}`;
    info(`Created key ${created.id} (${who}) in ${store.kind} store.`);
    info('Shown once — copy it now. Clients send it as: Authorization: Bearer <key>');
    out(created.key); // stdout only: KEY=$(knowledge-mcp keys create ...) works, and log masking does not touch it
    return;
  }
  if (sub === 'list') {
    const keys = await store.listKeys();
    if (!keys.length) return info('No keys. Create one: knowledge-mcp keys create --email you@example.com --role admin');
    for (const k of keys) {
      const state = !k.active ? 'revoked' : k.expiresAt && k.expiresAt < new Date().toISOString() ? 'expired' : 'active';
      out(`${k.id}  ${state.padEnd(7)}  ${(k.email ?? `(service, ${k.role})`).padEnd(30)}  ${k.label ?? ''}  created ${k.createdAt.slice(0, 10)}${k.expiresAt ? `  expires ${k.expiresAt.slice(0, 10)}` : ''}`);
    }
    return;
  }
  if (sub === 'revoke') {
    const id = rest[0];
    if (!id) throw new UsageError('keys revoke <id>');
    const ok = await store.revokeKey(id);
    info(ok ? `Revoked ${id}. Servers drop cached auth within AUTH_CACHE_TTL_MS (default 60s).` : `No active key ${id}.`);
    if (!ok) process.exitCode = 1;
    return;
  }
  throw new UsageError('keys create | keys list | keys revoke <id>');
}

async function cmdUsers(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const store = await getStore();
  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        role: { type: 'string' },
        name: { type: 'string' },
        tools: { type: 'string' },
        'slack-channels': { type: 'string' },
        'drive-folders': { type: 'string' },
      },
    });
    const email = positionals[0]?.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new UsageError('users add <email> [--role admin|member] [--tools a,b]');
    const existing = await store.getUser(email);
    const role = roleArg(values.role, ['admin', 'member']) ?? (existing?.role === 'admin' ? 'admin' : 'member');
    await store.upsertUser({
      email,
      role,
      name: values.name ?? existing?.name ?? null,
      allowedTools: csvList(values.tools) ?? existing?.allowedTools ?? null,
      allowedSlackChannels: csvList(values['slack-channels']) ?? existing?.allowedSlackChannels ?? null,
      allowedDriveFolders: csvList(values['drive-folders']) ?? existing?.allowedDriveFolders ?? null,
    });
    info(`${existing ? 'Updated' : 'Added'} ${email} as ${role}.`);
    return;
  }
  if (sub === 'list') {
    const users = await store.listUsers();
    if (!users.length) return info('No users. Add one: knowledge-mcp users add you@example.com --role admin');
    for (const u of users) {
      const limits = [
        u.allowedTools?.length ? `tools=${u.allowedTools.join(',')}` : '',
        u.allowedSlackChannels?.length ? `slack=${u.allowedSlackChannels.join(',')}` : '',
        u.allowedDriveFolders?.length ? `drive=${u.allowedDriveFolders.join(',')}` : '',
      ].filter(Boolean);
      out(`${u.email.padEnd(32)} ${(u.role === 'admin' ? 'admin' : 'member').padEnd(7)} ${limits.join('  ') || '(no limits)'}`);
    }
    return;
  }
  if (sub === 'remove') {
    const email = rest[0];
    if (!email) throw new UsageError('users remove <email>');
    const ok = await store.removeUser(email);
    info(ok ? `Removed ${email}. Their keys and sign-ins now get the viewer role.` : `No user ${email}.`);
    if (!ok) process.exitCode = 1;
    return;
  }
  throw new UsageError('users add <email> | users list | users remove <email>');
}

async function cmdDoctor(registry: Registry): Promise<void> {
  out(`Knowledge MCP ${VERSION}`);
  out(`config    ${configSource()}`);
  try {
    const store = await getStore();
    out(`store     ${store.kind} — ${store.location}`);
  } catch (e) {
    out(`store     ${storeKind()} — FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
  if (isOAuthConfigured()) out(`oauth     on — issuer ${OAUTH_ISSUER_URL}`);
  else if (oauthAttempted()) out(`oauth     off — missing ${oauthConfigProblems().join(', ')}`);
  else out('oauth     off (API keys only)');
  out('plugins');
  for (const p of registry.status()) {
    const on = p.tools.filter((t) => t.enabled).length;
    const head = `  ${p.enabled ? '✓' : '✗'} ${p.id.padEnd(12)}`;
    if (!p.enabled) {
      out(`${head} off — ${p.reason}`);
      continue;
    }
    out(`${head} ${on}/${p.tools.length} tools${p.upstreams.length ? ` + remote ${p.upstreams.join(', ')}` : ''}${p.description ? `  ${p.description}` : ''}`);
    for (const t of p.tools.filter((x) => !x.enabled)) out(`      - ${t.name} off — ${t.reason}`);
  }
  const remotes = getConfig().upstreams;
  if (remotes.length) {
    out('upstreams (config)');
    for (const u of remotes) {
      const token = u.tokenEnv ? ` token ${u.tokenEnv}=${process.env[u.tokenEnv] ? 'set' : 'MISSING'}` : '';
      out(`  · ${u.name.padEnd(12)} ${u.url}${token}`);
    }
  }
  const cmds = registry.plugins.flatMap((p) => Object.entries(p.commands ?? {}).map(([c, d]) => `  knowledge-mcp ${p.id} ${c}  — ${d.description}`));
  if (cmds.length) {
    out('plugin commands');
    for (const c of cmds) out(c);
  }
}

async function cmdPlugin(registry: Registry, pluginId: string, argv: string[]): Promise<boolean> {
  const plugin = registry.plugins.find((p) => p.id === pluginId);
  if (!plugin) return false;
  const [name, ...rest] = argv;
  const command = name ? plugin.commands?.[name] : undefined;
  if (!command) {
    const list = Object.keys(plugin.commands ?? {});
    throw new UsageError(list.length ? `${pluginId} commands: ${list.join(', ')}` : `plugin ${pluginId} has no commands`);
  }
  await command.run(rest);
  return true;
}

export async function run(opts: RunOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);
  const [cmd = 'serve', ...rest] = argv;
  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP);
    if (cmd === 'version' || cmd === '--version' || cmd === '-v') return out(VERSION);
    if (cmd === 'keys') return await cmdKeys(rest);
    if (cmd === 'users') return await cmdUsers(rest);
    const registry = new Registry(opts.plugins ?? builtinPlugins);
    if (cmd === 'serve' || cmd === '--stdio') return await cmdServe(registry, cmd === '--stdio' ? ['--stdio'] : rest);
    if (cmd === 'doctor') return await cmdDoctor(registry);
    if (await cmdPlugin(registry, cmd, rest)) return;
    throw new UsageError(`unknown command "${cmd}". Run: knowledge-mcp help`);
  } catch (e) {
    if (e instanceof UsageError) {
      info(`usage: knowledge-mcp ${e.message}`);
      process.exit(2);
    }
    info(`[knowledge-mcp] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
