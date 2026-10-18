/**
 * Health check tool — always listed, no permission group. Shows who you are and which plugins are on.
 * Call it first when a tool you just added does not show up.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthContext } from '../core/auth.js';
import { VERSION } from '../version.js';
import type { Registry } from './registry.js';
import { inputJsonSchema, textResult } from './result.js';

const input = z.object({
  echo: z.string().default('pong').describe('Returned as is. Default "pong".'),
});

export const pingTool: Tool = {
  name: 'ping',
  description:
    'Health check. Verifies the server, your auth and which plugins are on. ' +
    'Call it first when a tool you expect is missing.',
  inputSchema: inputJsonSchema('ping', input) as Tool['inputSchema'],
};

export function handlePing(registry: Registry, auth: AuthContext, args: unknown) {
  const { echo } = input.parse(args ?? {});
  const admin = auth.role === 'admin';
  return textResult(
    JSON.stringify(
      {
        ok: true,
        echo,
        server: 'knowledge-mcp',
        version: VERSION,
        timestamp: new Date().toISOString(),
        authenticated_as: auth.email ?? auth.org_id ?? null,
        role: auth.role ?? null,
        // Plugin on/off is useful to everyone; the reason (env names) only to admins.
        plugins: registry.status().map((p) => (admin ? { id: p.id, enabled: p.enabled, reason: p.reason } : { id: p.id, enabled: p.enabled })),
        upstreams: admin ? registry.upstreams.statuses() : undefined,
      },
      null,
      2,
    ),
  );
}
