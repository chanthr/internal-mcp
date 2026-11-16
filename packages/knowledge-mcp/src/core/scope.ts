/**
 * Per-user permission checks: filters tools, channels and folders by tool group (= plugin id) and
 * AuthContext.scopes (app_users allowed_*).
 *
 * Principles:
 *   - admin ignores every scope (everything allowed), so operators cannot lock themselves out.
 *   - member (a user registered in app_users): if a dimension's scope is null/undefined/an empty array, that dimension
 *     is fully allowed (unset = gradual rollout). If an explicit array is set, only its entries are allowed.
 *   - viewer (not in app_users, or the lookup failed): denied by default. Only tool groups listed in config
 *     access.viewerTools are allowed.
 *     This keeps an account that merely passed sign-in from reading all of Drive, Slack and the logs.
 *   - A tool without a tool group is allowed only if it is ping. A new tool outside any plugin is denied by default.
 * Drive excluded folders (PII, contracts, HR) always apply, independently of these scopes.
 */
import type { AuthContext } from './auth.js';
import { getConfig } from './config.js';

// Safe tools that are always allowed even without a tool group (health check). Explicit whitelist.
const NO_SCOPE_TOOLS = new Set<string>(['ping']);

/**
 * Whether this tool may be listed and called. group = id of the plugin the tool belongs to (registry.groupOf), or null.
 * admin = everything, member = allowed_tools (unset = everything), viewer = only what config access.viewerTools opens.
 */
export function isToolAllowed(auth: AuthContext, name: string, group: string | null): boolean {
  if (auth.role === 'admin') return true;
  if (group === null) return NO_SCOPE_TOOLS.has(name);
  if (auth.role !== 'member') return getConfig().access.viewerTools.includes(group);
  const tools = auth.scopes?.tools;
  if (!tools || tools.length === 0) return true; // unset = every tool group
  return tools.includes(group);
}

/** Set of allowed Slack channel ids. null = everything allowed (admin, or unset). */
export function allowedSlackChannels(auth: AuthContext): Set<string> | null {
  if (auth.role === 'admin') return null;
  const ch = auth.scopes?.slackChannels;
  if (!ch || ch.length === 0) return null;
  return new Set(ch);
}

/** Array of allowed Drive folder path prefixes. null = everything allowed (admin, or unset). */
export function allowedDriveFolders(auth: AuthContext): string[] | null {
  if (auth.role === 'admin') return null;
  const f = auth.scopes?.driveFolders;
  if (!f || f.length === 0) return null;
  return f;
}

/**
 * Whether path is under an allowed folder prefix. prefixes null = everything allowed.
 * path examples: "Engineering/backend/...", "Clients/Acme/proposal.pptx".
 * prefix example: "Clients" allows everything under it. Exact match, or starts with "prefix/".
 * Both sides are normalized to NFC: Korean names uploaded from macOS arrive in NFD (decomposed jamo), so the same
 * characters would otherwise compare as different.
 */
export function isPathInScope(path: string, prefixes: string[] | null): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  const norm = String(path).normalize('NFC').replace(/^\/+/, '');
  return prefixes.some((p) => {
    const pp = String(p).normalize('NFC').replace(/^\/+|\/+$/g, '');
    if (!pp) return false;
    return norm === pp || norm.startsWith(pp + '/');
  });
}

/**
 * Whether path is an ancestor of an allowed folder: "Clients" is an ancestor of the prefix "Clients/Acme".
 * Used to keep a way down to the allowed folder in folder listings (only the ancestor folder name shows; other
 * contents are filtered out).
 */
export function isScopeAncestor(path: string, prefixes: string[] | null): boolean {
  if (!prefixes || prefixes.length === 0) return false;
  const norm = String(path).normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!norm) return true;
  return prefixes.some((p) => String(p).normalize('NFC').replace(/^\/+|\/+$/g, '').startsWith(norm + '/'));
}
