/**
 * Health check tool.
 *
 * server·인증·환경 정상 동작 확인용. 다른 도구 추가 시 같은 패턴 복제.
 */
import { z } from 'zod';
import { getAuth } from '../lib/context.js';
import { upstreamManager } from '../lib/mcp_upstream.js';

export const pingTool = {
  name: 'ping',
  description:
    'Health check. Verifies the server, auth, and environment. ' +
    '도구 추가 디버깅 시 가장 먼저 호출.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      echo: {
        type: 'string',
        description: '입력 그대로 echo back. 기본 "pong".',
      },
    },
  },
};

const inputSchema = z.object({
  echo: z.string().default('pong'),
});

export async function handlePing(args: unknown) {
  try {
    const auth = getAuth();
    const { echo } = inputSchema.parse(args);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              echo,
              server: 'knowledge-mcp',
              version: '0.2.0',
              timestamp: new Date().toISOString(),
              authenticated_as: auth.email ?? auth.org_id ?? null,
              role: auth.role ?? null,
              upstreams: upstreamManager.statuses(),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (e: unknown) {
    return {
      content: [{ type: 'text' as const, text: `[error] ping 실패: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
}
