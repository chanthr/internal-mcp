/**
 * Turns what a tool returns (or throws) into an MCP CallTool result, and zod schemas into JSON Schema.
 */
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { ToolError, type ToolResult, type ToolReturn } from './define.js';

export type JsonSchemaObject = { type: 'object'; properties?: Record<string, unknown>; [k: string]: unknown };

const EMPTY_INPUT: JsonSchemaObject = { type: 'object', properties: {} };

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function isToolResult(v: unknown): v is ToolResult {
  return !!v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content);
}

/** string → text, MCP result → as is, anything else → pretty JSON text. */
export function normalizeResult(v: ToolReturn): ToolResult {
  if (typeof v === 'string') return textResult(v);
  if (isToolResult(v)) return v;
  if (v === undefined) return textResult('(no result)');
  return textResult(JSON.stringify(v, null, 2));
}

/** zod 3 and zod 4 errors both carry `issues` with path and message. */
export function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: PropertyKey[]; message?: string }> } | null)?.issues;
  if (Array.isArray(issues) && issues.length) {
    return issues.map((i) => `${(i.path ?? []).map(String).join('.') || '(root)'}: ${i.message ?? 'invalid'}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

export function isValidationError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return (name === 'ZodError' || name === '$ZodError') && Array.isArray((err as { issues?: unknown }).issues);
}

/** Map a thrown error to a result the model can read. */
export function errorResult(toolName: string, err: unknown): ToolResult {
  if (isValidationError(err)) {
    return textResult(`[invalid_input] tool '${toolName}': ${formatValidationError(err)}`, true);
  }
  if (err instanceof ToolError) return textResult(`[error] ${err.message}`, true);
  const msg = err instanceof Error ? err.message : String(err);
  return textResult(`[fatal] ${msg}`, true);
}

/**
 * zod object schema → JSON Schema for tools/list. Unlike the SDK's McpServer, this keeps the properties of
 * schemas wrapped in `.refine()` (zod 3 effects). Fails at boot when the input is not an object.
 */
export function inputJsonSchema(toolName: string, schema: AnySchema | undefined): JsonSchemaObject {
  if (!schema) return EMPTY_INPUT;
  const json = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object') {
    throw new Error(`[plugin] tool "${toolName}": input must be a zod object schema (z.object({...}))`);
  }
  return json as JsonSchemaObject;
}
