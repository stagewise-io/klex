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
}

export interface ToolSearchResult {
  reference: ToolReference;
  description?: string;
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
