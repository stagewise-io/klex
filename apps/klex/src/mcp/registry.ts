import { createHash } from 'node:crypto';

import type {
  CallToolResult,
  Tool as McpToolDefinition,
} from '@modelcontextprotocol/client';

import {
  assertJsonValue,
  type JsonObject,
  type JsonValue,
  type ToolDescription,
} from '@/tool-provider';

import type { McpConnection } from './connection';

export interface RegisteredMcpTool {
  readonly tool: McpToolDefinition;
  readonly descriptor: ToolDescription;
}

export interface RegisteredMcpNamespace {
  /** Absent while an on-demand server is in standby. */
  readonly connection: McpConnection | undefined;
  readonly tools: ReadonlyMap<string, RegisteredMcpTool>;
}

export type McpRegistry = ReadonlyMap<string, RegisteredMcpNamespace>;

/** Tools of one namespace: live, or retained from a no-wake catalog. */
export interface McpToolSource {
  readonly tools: readonly McpToolDefinition[];
  readonly connection: McpConnection | undefined;
}

export function buildMcpRegistry(
  sources: ReadonlyMap<string, McpToolSource>,
): McpRegistry {
  const registry = new Map<string, RegisteredMcpNamespace>();
  for (const namespace of [...sources.keys()].sort()) {
    const source = sources.get(namespace);
    if (!source) continue;
    const { connection } = source;
    const tools = new Map<string, RegisteredMcpTool>();
    for (const tool of [...source.tools].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (tools.has(tool.name))
        throw new Error(`Duplicate MCP tool name: ${namespace}.${tool.name}`);
      const inputSchema = normalizeInputSchema(tool.inputSchema);
      tools.set(tool.name, {
        tool,
        descriptor: {
          reference: { namespace, name: tool.name },
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema,
          ...(tool.outputSchema
            ? { outputSchema: tool.outputSchema as JsonObject }
            : {}),
        },
      });
    }
    registry.set(namespace, { connection, tools });
  }
  return registry;
}

export function countMcpTools(registry: McpRegistry): number {
  let count = 0;
  for (const namespace of registry.values()) count += namespace.tools.size;
  return count;
}

export function normalizeCallToolResult(result: CallToolResult): JsonValue {
  const normalized = {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
  assertJsonValue(normalized);
  return normalized;
}

export function canonicalConfigSignature(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJson(value)))
    .digest('hex');
}

function normalizeInputSchema(
  schema: McpToolDefinition['inputSchema'],
): JsonObject {
  assertJsonValue(schema);
  return schema as JsonObject;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
