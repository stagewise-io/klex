import type { JsonObject, JsonValue } from './json';

export interface ToolReference {
  namespace: string;
  name: string;
}

export interface ToolRequestContext {
  executionId: string;
  signal: AbortSignal;
  sessionId?: string;
}

/** Summaries are lossy hints, never validation contracts. */
export type ToolSummary = [
  name: string,
  description: string,
  inputSummary: JsonObject,
  incomplete: boolean,
];
export interface ToolPage {
  mcpServer: string;
  format: 'tool-summary-v1';
  items: ToolSummary[];
  total: number;
  nextCursor: number | null;
  hint?: string;
}

export type ToolErrorCode =
  | 'unknown-server'
  | 'server-unavailable'
  | 'authorization-required'
  | 'tool-not-found'
  | 'invalid-params'
  | 'invalid-schema'
  | 'unsupported-schema'
  | 'invalid-query'
  | 'invalid-cursor'
  | 'catalog-too-large'
  | 'transport-failure'
  | 'cancelled'
  | 'invalid-output'
  | 'result-too-large'
  | 'tool-info-too-large';

/** Locally authored messages only: never expose remote exceptions or input values. */
export class ToolGatewayError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly issues: readonly { path: string; keyword: string }[] = [],
    readonly details?: { actualBytes: number; allowedBytes: number },
  ) {
    super(message);
    this.name = 'ToolGatewayError';
  }
}

export interface ToolProvider {
  listTools(
    mcpServer: string,
    searchString: string,
    cursor: number,
    context: ToolRequestContext,
  ): Promise<ToolPage>;
  getToolInfo(
    reference: ToolReference,
    context: ToolRequestContext,
  ): Promise<JsonObject>;
  invoke(
    reference: ToolReference,
    input: JsonObject,
    context: ToolRequestContext,
  ): Promise<JsonValue>;
  releaseToolSession(sessionId: string): void;
}
