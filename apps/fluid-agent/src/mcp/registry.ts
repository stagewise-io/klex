import type { CallToolResult, Tool } from '@modelcontextprotocol/client';

import {
  assertJsonValue,
  type JsonObject,
  type JsonValue,
} from '@/toolbox/serialization';
import type { CapabilityDescription } from '@/toolbox/toolbox';

import type { McpConnection } from './connection';

export interface RegisteredMcpTool {
  readonly tool: Tool;
  readonly descriptor: CapabilityDescription;
}

export interface RegisteredMcpNamespace {
  readonly connection: McpConnection;
  readonly tools: ReadonlyMap<string, RegisteredMcpTool>;
}

export type McpRegistry = ReadonlyMap<string, RegisteredMcpNamespace>;

export function buildMcpRegistry(
  connections: ReadonlyMap<string, McpConnection>,
): McpRegistry {
  const registry = new Map<string, RegisteredMcpNamespace>();
  for (const namespace of [...connections.keys()].sort()) {
    const connection = connections.get(namespace);
    if (!connection) continue;
    const tools = new Map<string, RegisteredMcpTool>();
    for (const tool of [...connection.tools].sort((a, b) =>
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
  return JSON.stringify(sortJson(value));
}

function normalizeInputSchema(schema: Tool['inputSchema']): JsonObject {
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
