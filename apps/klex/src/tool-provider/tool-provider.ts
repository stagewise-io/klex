import type { JsonObject, JsonValue } from './json';

export interface ToolReference {
  namespace: string;
  name: string;
}

export interface ToolSnapshot {
  namespaces: readonly {
    name: string;
    capabilities: readonly { name: string }[];
  }[];
}

export interface ToolSearchOptions {
  limit?: number;
  includeInputSchema?: boolean;
}

export const TOOL_SEARCH_USAGE =
  'Use tools.search(query: string, options?: { limit?: number, includeInputSchema?: boolean }), e.g. tools.search("deployment", { limit: 5, includeInputSchema: true }).';

/** Shared validation for guest, worker protocol, and direct provider calls. */
export function parseToolSearchOptions(value: unknown): ToolSearchOptions {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(
      `Search options must be an object. ${TOOL_SEARCH_USAGE}`,
    );
  const limit = 'limit' in value ? value.limit : undefined;
  const includeInputSchema =
    'includeInputSchema' in value ? value.includeInputSchema : undefined;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
  )
    throw new TypeError(
      `Search limit must be a positive finite integer. ${TOOL_SEARCH_USAGE}`,
    );
  if (
    includeInputSchema !== undefined &&
    typeof includeInputSchema !== 'boolean'
  )
    throw new TypeError(
      `includeInputSchema must be a boolean. ${TOOL_SEARCH_USAGE}`,
    );
  if (includeInputSchema && limit !== undefined && limit > 20)
    throw new TypeError(
      `Schema-inclusive search limit must be at most 20. ${TOOL_SEARCH_USAGE}`,
    );
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(includeInputSchema === undefined ? {} : { includeInputSchema }),
  };
}

export function toolSearchLimit(
  options: ToolSearchOptions,
): number | undefined {
  return options.limit ?? (options.includeInputSchema ? 5 : undefined);
}

export interface ToolSearchResult {
  reference: ToolReference;
  description?: string;
  inputSchema?: JsonObject;
}

export interface ToolDescription {
  reference: ToolReference;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}

export interface ToolRequestContext {
  executionId: string;
  signal: AbortSignal;
  /**
   * UUID of the session that initiated the tool request, when available.
   * Used for associating MCP tool calls with sessions in observability.
   */
  sessionId?: string;
}

export interface ToolProvider {
  snapshot(context: ToolRequestContext): Promise<ToolSnapshot>;
  search(
    query: string,
    options: ToolSearchOptions,
    context: ToolRequestContext,
  ): Promise<ToolSearchResult[]>;
  describe(
    reference: ToolReference,
    context: ToolRequestContext,
  ): Promise<ToolDescription>;
  invoke(
    reference: ToolReference,
    input: JsonObject,
    context: ToolRequestContext,
  ): Promise<JsonValue>;
}
