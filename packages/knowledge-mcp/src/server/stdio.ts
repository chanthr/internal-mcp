/**
 * stdio transport — the MCP client starts this process and talks over stdin/stdout. One process = one user.
 *
 * Without MCP_API_KEY the process runs as the local admin: whoever can start it already holds every token
 * in its env, so a key adds no boundary. With MCP_API_KEY the key is checked like on HTTP, and a key tied
 * to an email gets that person's role and scopes from app_users.
 *
 * stdout carries the protocol. Log only with console.error.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authenticateApiKey, type AuthContext } from '../core/auth.js';
import { setProcessAuth } from '../core/context.js';
import { getConfig, configSource } from '../core/config.js';
import { getStore, scheduleToolLogPrune } from '../store/index.js';
import type { Registry } from '../plugin/registry.js';
import { resolveUser } from './identity.js';
import { createMcpServer } from './mcp.js';

export async function runStdio(registry: Registry): Promise<void> {
  const key = process.env.MCP_API_KEY?.trim();
  let auth: AuthContext;
  if (!key) {
    auth = { ok: true, org_id: getConfig().orgId, role: 'admin', email: 'local@stdio' };
  } else {
    auth = await authenticateApiKey(key);
    if (!auth.ok) {
      console.error(`[knowledge-mcp] stdio auth failed: ${auth.reason}. Check MCP_API_KEY, or unset it to run as the local admin.`);
      process.exit(1);
    }
    if (auth.email) {
      const { role, scopes } = await resolveUser(auth.key_id ?? 'direct', auth.email);
      auth = { ...auth, role, scopes };
    }
  }
  // Set before the transport exists — see context.ts for why AsyncLocalStorage.enterWith is not enough.
  setProcessAuth(auth);
  scheduleToolLogPrune(await getStore());
  void registry.start({ jobs: false }); // remotes only — background jobs belong to the long-running HTTP server
  const server = createMcpServer(registry);
  await server.connect(new StdioServerTransport());
  console.error(
    `[knowledge-mcp] stdio mode · ${auth.email ?? auth.org_id} (${auth.role}) · config=${configSource()} · ${registry.summary()}`,
  );
}
