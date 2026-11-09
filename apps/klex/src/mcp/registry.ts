import { createHash } from 'node:crypto';

import type {
  CallToolResult,
  Tool as McpToolDefinition,
} from '@modelcontextprotocol/client';

import {
  assertJsonValue,
  type JsonObject,
  type JsonValue,
} from '@/tool-provider';

import type { McpConnection } from './connection';
import { compileToolValidator } from './tool-validation';

export interface RegisteredMcpTool {
  readonly tool: McpToolDefinition;
  readonly validate: (input: JsonObject) => void;
}

export interface RegisteredMcpNamespace {
  readonly connection: McpConnection;
  readonly tools: ReadonlyMap<string, RegisteredMcpTool>;
  readonly definitions: readonly McpToolDefinition[];
}

export type McpRegistry = ReadonlyMap<string, RegisteredMcpNamespace>;

export function buildMcpRegistry(
  connections: ReadonlyMap<string, McpConnection>,
  previous: McpRegistry = new Map(),
): McpRegistry {
  const registry = new Map<string, RegisteredMcpNamespace>();
  namespaces: for (const namespace of [...connections.keys()].sort()) {
    const connection = connections.get(namespace);
    if (!connection) continue;
    const old = previous.get(namespace);
    if (
      old?.connection === connection &&
      old.definitions === connection.tools
    ) {
      registry.set(namespace, old);
      continue;
    }
    const tools = new Map<string, RegisteredMcpTool>();
    for (const tool of connection.tools) {
      // An ambiguous catalog is unavailable, without poisoning healthy servers.
      if (tools.has(tool.name)) continue namespaces;
      let compiled: ((input: JsonObject) => void) | undefined;
      // Compile lazily once per generation, including failures. Catalog publication
      // must not compile thousands of untrusted schemas on the connection path.
      const validate = (input: JsonObject) => {
        if (!compiled) {
          try {
            compiled = compileToolValidator(
              normalizeInputSchema(tool.inputSchema),
            );
          } catch (error) {
            compiled = () => {
              throw error;
            };
          }
        }
        compiled(input);
      };
      tools.set(tool.name, { tool, validate });
    }
    registry.set(namespace, {
      connection,
      tools,
      definitions: connection.tools,
    });
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
