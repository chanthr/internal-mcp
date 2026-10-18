/**
 * One MCP server instance (per HTTP session, or one for stdio). Lists and routes tools from the registry,
 * filtered by the caller's permission, and logs every call.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAuthMaybe } from '../core/context.js';
import { isToolAllowed } from '../core/scope.js';
import { logToolCall } from '../store/tool_log.js';
import { VERSION } from '../version.js';
import { PING, type Registry } from '../plugin/registry.js';
import { handlePing, pingTool } from '../plugin/ping.js';
import { errorResult, textResult } from '../plugin/result.js';

export function createMcpServer(registry: Registry): Server {
  const server = new Server(
    { name: 'knowledge-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: registry.instructions() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Plugins without their credentials are already left out, so the model never tries a tool that can't work.
    const tools = registry.listTools(pingTool);
    const auth = getAuthMaybe();
    if (!auth || !auth.ok) return { tools: tools.filter((t) => t.name === PING) };
    return { tools: tools.filter((t) => isToolAllowed(auth, t.name, registry.groupOf(t.name))) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const t0 = Date.now();
    const auth = getAuthMaybe();

    const result = await (async () => {
      // Checked again on call, not only on list (defense in depth). No auth = deny.
      if (!auth || !auth.ok || !isToolAllowed(auth, name, registry.groupOf(name))) {
        return textResult(`[forbidden] 도구 '${name}' 은 현재 직원 권한으로 접근 불가입니다.`, true);
      }
      if (name === PING) {
        try {
          return handlePing(registry, auth, args);
        } catch (e) {
          return errorResult(name, e);
        }
      }
      return registry.call(name, args, auth);
    })();

    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    logToolCall({
      tool: name,
      auth,
      ok: r.isError !== true,
      error: r.isError === true ? (r.content?.find((c) => c.type === 'text')?.text ?? null) : null,
      durationMs: Date.now() - t0,
    });
    return result;
  });

  return server;
}
