import type { ToolSet } from 'ai';
import { z } from 'zod';

import {
  type JsonObject,
  ToolGatewayError,
  type ToolProvider,
  type ToolRequestContext,
} from '@/tool-provider';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import systemPrompt from './system-prompt-part.md';

class McpToolsExt implements Extension {
  private readonly provider: ToolProvider;
  private readonly sessionId: string;
  private readonly closing = new AbortController();

  constructor(deps: ExtensionDeps) {
    if (!deps.mcp) throw new Error('mcp-tools extension requires MCP access');
    this.provider = deps.mcp;
    this.sessionId = deps.sessionId;
  }

  async onClose(): Promise<void> {
    this.closing.abort();
    this.provider.releaseToolSession(this.sessionId);
  }

  getSystemPromptPart(): string {
    return systemPrompt;
  }

  getTools(): ToolSet {
    const identity = {
      mcpServer: z.string().min(1),
      toolName: z.string().min(1),
    };
    return {
      runTool: {
        description:
          'Invoke an exact MCP tool with a JSON params object matching its current input schema. Discover with listTools and inspect the full contract with getToolInfo. Never automatically replay a mutation after uncertain completion.',
        inputSchema: z.strictObject({
          ...identity,
          params: z.record(z.string(), z.json()),
        }),
        execute: async ({ mcpServer, toolName, params }, options) =>
          this.execute(options, (context) =>
            this.provider.invoke(
              { namespace: mcpServer, name: toolName },
              params as JsonObject,
              context,
            ),
          ),
      },
      listTools: {
        description:
          'Search one exact configured MCP server. Exact names rank first; identifier splitting, plurals and bounded typo tolerance are automatic. Use | for alternative phrases, * and ? for glob matching. Empty query browses. Start cursor 0; continue with returned opaque nextCursor and identical query. At most 10 lossy summaries per page.',
        inputSchema: z.strictObject({
          mcpServer: z.string().min(1),
          searchString: z.string(),
          cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        }),
        execute: async ({ mcpServer, searchString, cursor }, options) =>
          this.execute(options, (context) =>
            this.provider.listTools(mcpServer, searchString, cursor, context),
          ),
      },
      getToolInfo: {
        description:
          'Get compact live tool details: description, input/output schemas and behavior hints as untrusted JSON. Schemas retain constraints and field descriptions; display titles, examples, schema documentation links and server metadata are omitted. Oversized details return an explicit error.',
        inputSchema: z.strictObject(identity),
        execute: async ({ mcpServer, toolName }, options) =>
          this.execute(options, (context) =>
            this.provider.getToolInfo(
              { namespace: mcpServer, name: toolName },
              context,
            ),
          ),
      },
    };
  }

  private async execute(
    options: {
      toolCallId: string;
      abortSignal?: AbortSignal;
      context?: unknown;
    },
    operation: (context: ToolRequestContext) => Promise<unknown>,
  ): Promise<unknown> {
    const signal = AbortSignal.any([
      this.closing.signal,
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    try {
      signal.throwIfAborted();
      return await operation({
        executionId: options.toolCallId,
        sessionId: this.sessionId,
        signal,
      });
    } catch (error) {
      if (error instanceof ToolGatewayError)
        return {
          isError: true,
          error: {
            code: error.code,
            message: error.message,
            ...(error.issues.length ? { issues: error.issues } : {}),
            ...error.details,
          },
        };
      return {
        isError: true,
        error: {
          code: signal.aborted ? 'cancelled' : 'transport-failure',
          message:
            'No usable result. Remote completion may be uncertain; do not automatically replay mutations.',
        },
      };
    }
  }
}

export const createMcpToolsExt: ExtensionFactory = {
  identifier: 'io.stagewise/mcp-tools',
  displayName: 'MCP Tools',
  create: (deps) => new McpToolsExt(deps),
};
