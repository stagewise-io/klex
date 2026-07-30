import { extendZodWithOpenApi, z } from '@hono/zod-openapi';

// Extend Zod with .openapi() metadata support for spec generation.
extendZodWithOpenApi(z);

// --- Shared ---

const errorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi('ErrorResponse');

// --- Health ---

const healthResponseSchema = z
  .object({
    status: z.string(),
    timestamp: z.string().datetime(),
  })
  .openapi('HealthResponse');

// --- Sessions ---

const sessionStatusSchema = z
  .enum(['active', 'terminated'])
  .openapi('SessionStatus');

const sessionRuntimeStateSchema = z
  .enum(['working', 'retrying', 'success', 'idle', 'terminated'])
  .openapi('SessionRuntimeState');

const sessionModelInfoSchema = z
  .object({
    id: z.string(),
    isFallback: z.boolean(),
    fallbackIndex: z.number().int().min(0),
  })
  .openapi('SessionModelInfo');

const usageSchema = z
  .object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    inputCacheWriteTokens: z.number().int().min(0),
    inputCacheReadTokens: z.number().int().min(0),
  })
  .openapi('Usage');

const usagePairSchema = z
  .object({
    latest: usageSchema.nullable(),
    total: usageSchema,
  })
  .openapi('UsagePair');

const sessionInfoSchema = z
  .object({
    id: z.string().uuid(),
    status: sessionStatusSchema,
    runtimeState: sessionRuntimeStateSchema,
    model: sessionModelInfoSchema,
    usage: z.object({
      chat: usagePairSchema,
      extensions: z.record(z.string(), usagePairSchema),
    }),
    turns: z.number().int().min(0),
    steps: z.number().int().min(0),
    messageCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
  })
  .openapi('SessionInfo');

const sessionsResponseSchema = z
  .object({
    sessions: z.array(sessionInfoSchema),
  })
  .openapi('SessionsResponse');

// --- MCP ---

const mcpConnectionStatusSchema = z
  .enum(['connected', 'connecting', 'error', 'disconnected'])
  .openapi('McpConnectionStatus');

const mcpServerInfoSchema = z
  .object({
    name: z.string(),
    status: mcpConnectionStatusSchema,
    toolCount: z.number().int().min(0),
    supportsFluidEvents: z.boolean(),
    transport: z.enum(['stdio', 'http']),
  })
  .openapi('McpServerInfo');

const mcpServersResponseSchema = z
  .object({
    servers: z.array(mcpServerInfoSchema),
  })
  .openapi('McpServersResponse');

const createMcpServerBodySchema = z
  .union([
    z.object({
      name: z.string().min(1),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      name: z.string().min(1),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ])
  .openapi('CreateMcpServerBody');

const updateMcpServerBodySchema = z
  .union([
    z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ])
  .openapi('UpdateMcpServerBody');

const mcpToolCallRecordSchema = z
  .object({
    id: z.string(),
    namespace: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.any()),
    result: z.any().nullable(),
    isError: z.boolean(),
    sessionId: z.string().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .openapi('McpToolCallRecord');

const toolCallHistoryResponseSchema = z
  .object({
    toolCalls: z.array(mcpToolCallRecordSchema),
  })
  .openapi('ToolCallHistoryResponse');

const mcpServerNameParamSchema = z.object({
  name: z.string().min(1),
});

// --- Settings / Model Selection ---

const modelIdSchema = z
  .string()
  .regex(/^[^:]+:.+$/, {
    error:
      'Model ID must use the format providerId:modelId (preset) or providerId:endpointId:modelId (manual) with non-empty segments',
  })
  .openapi('ModelId');

const modelSelectionSchema = z
  .object({
    chat: z.array(modelIdSchema),
    compaction: z.array(modelIdSchema),
    memory: z.array(modelIdSchema),
  })
  .openapi('ModelSelection');

const modelSelectionPatchSchema = z
  .object({
    chat: z.array(modelIdSchema).optional(),
    compaction: z.array(modelIdSchema).optional(),
    memory: z.array(modelIdSchema).optional(),
  })
  .openapi('ModelSelectionPatch');

export {
  createMcpServerBodySchema,
  errorResponseSchema,
  healthResponseSchema,
  mcpServerNameParamSchema,
  mcpServersResponseSchema,
  modelIdSchema,
  modelSelectionPatchSchema,
  modelSelectionSchema,
  sessionInfoSchema,
  sessionsResponseSchema,
  toolCallHistoryResponseSchema,
  updateMcpServerBodySchema,
};
