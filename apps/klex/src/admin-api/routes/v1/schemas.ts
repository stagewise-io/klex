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

// --- MCP ---

const mcpConnectionStatusSchema = z
  .enum(['connected', 'connecting', 'error', 'disconnected'])
  .openapi('McpConnectionStatus');

const mcpServerInfoSchema = z
  .object({
    name: z.string(),
    status: mcpConnectionStatusSchema,
    toolCount: z.number().int().min(0),
    supportsPushNotifications: z.boolean(),
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

// --- Introspection ---

const introspectionChildSchema = z
  .object({
    id: z.string(),
    hasState: z.boolean(),
    hasChildren: z.boolean(),
  })
  .openapi('IntrospectionChild');

const introspectionNodeSchema = z
  .object({
    path: z.array(z.string()),
    state: z.record(z.string(), z.unknown()).nullable(),
    children: z.array(introspectionChildSchema),
  })
  .openapi('IntrospectionNode');

const introspectionPathParamsSchema = z.object({
  path: z.string().min(1).openapi({
    description:
      'Slash-separated path segments for hierarchy traversal (e.g. "sessions" or "sessions/sess-001/extensions/io.stagewise%2Fcontext-compaction"). URL-encode slashes that are part of an individual segment ID (e.g. %2F in io.stagewise%2Fcontext-compaction).',
    example: 'sessions/sess-001',
  }),
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

// --- Providers ---

const apiFormatSchema = z
  .enum([
    'openai',
    'anthropic',
    'google',
    'chat-completions',
    'open-responses',
    'messages',
  ])
  .openapi('ApiFormat');

const endpointAuthSchema = z
  .object({
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('EndpointAuth');

const endpointConfigSchema = z
  .object({
    url: z.url(),
    format: apiFormatSchema,
    auth: endpointAuthSchema,
  })
  .openapi('EndpointConfig');

const providerPresetSchema = z
  .enum(['openai', 'anthropic', 'google'])
  .openapi('ProviderPreset');

const providerResponseSchema = z
  .union([
    z.object({
      name: z.string(),
      preset: providerPresetSchema,
      auth: endpointAuthSchema,
    }),
    z.object({
      name: z.string(),
      endpoints: z.record(z.string(), endpointConfigSchema),
    }),
  ])
  .openapi('Provider');

const providersResponseSchema = z
  .object({
    providers: z.array(providerResponseSchema),
  })
  .openapi('ProvidersResponse');

const createProviderBodySchema = z
  .union([
    z.object({
      name: z.string().min(1),
      preset: providerPresetSchema,
      auth: endpointAuthSchema,
    }),
    z.object({
      name: z.string().min(1),
      endpoints: z.record(z.string(), endpointConfigSchema),
    }),
  ])
  .openapi('CreateProviderBody');

const updateProviderBodySchema = z
  .object({
    preset: providerPresetSchema.optional(),
    auth: endpointAuthSchema.optional(),
    endpoints: z.record(z.string(), endpointConfigSchema).optional(),
  })
  .openapi('UpdateProviderBody');

const providerNameParamSchema = z.object({
  name: z.string().min(1),
});

const endpointWithNameSchema = z
  .object({
    name: z.string(),
    url: z.url(),
    format: apiFormatSchema,
    auth: endpointAuthSchema,
  })
  .openapi('EndpointWithName');

const endpointsResponseSchema = z
  .object({
    endpoints: z.array(endpointWithNameSchema),
  })
  .openapi('EndpointsResponse');

const createEndpointBodySchema = z
  .object({
    name: z.string().min(1),
    url: z.url(),
    format: apiFormatSchema,
    auth: endpointAuthSchema,
  })
  .openapi('CreateEndpointBody');

const updateEndpointBodySchema = z
  .object({
    url: z.url().optional(),
    format: apiFormatSchema.optional(),
    auth: endpointAuthSchema.optional(),
  })
  .openapi('UpdateEndpointBody');

const endpointNameParamSchema = z.object({
  name: z.string().min(1),
  endpointName: z.string().min(1),
});

// --- Known Models ---

const knownModelSchema = z
  .object({
    modelId: z.string().min(1),
    endpointName: z.string().optional(),
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
  })
  .openapi('KnownModel');

const knownModelsResponseSchema = z
  .object({
    models: z.array(knownModelSchema),
  })
  .openapi('KnownModelsResponse');

const createKnownModelBodySchema = z
  .object({
    modelId: z.string().min(1),
    endpointName: z.string().min(1).optional(),
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
  })
  .refine((d) => d.displayName !== undefined || d.contextSize !== undefined, {
    message: 'At least one of displayName or contextSize must be provided',
  })
  .openapi('CreateKnownModelBody');

const updateKnownModelBodySchema = z
  .object({
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
  })
  .openapi('UpdateKnownModelBody');

const knownModelIdParamSchema = z.object({
  name: z.string().min(1),
  modelId: z.string().min(1),
});

const knownModelQuerySchema = z.object({
  endpointName: z.string().min(1).optional(),
});

export {
  apiFormatSchema,
  createEndpointBodySchema,
  createKnownModelBodySchema,
  createMcpServerBodySchema,
  createProviderBodySchema,
  endpointAuthSchema,
  endpointConfigSchema,
  endpointNameParamSchema,
  endpointsResponseSchema,
  endpointWithNameSchema,
  errorResponseSchema,
  healthResponseSchema,
  introspectionChildSchema,
  introspectionNodeSchema,
  introspectionPathParamsSchema,
  knownModelIdParamSchema,
  knownModelQuerySchema,
  knownModelSchema,
  knownModelsResponseSchema,
  mcpServerNameParamSchema,
  mcpServersResponseSchema,
  modelIdSchema,
  modelSelectionPatchSchema,
  modelSelectionSchema,
  providerNameParamSchema,
  providerPresetSchema,
  providerResponseSchema,
  providersResponseSchema,
  toolCallHistoryResponseSchema,
  updateEndpointBodySchema,
  updateKnownModelBodySchema,
  updateMcpServerBodySchema,
  updateProviderBodySchema,
};
