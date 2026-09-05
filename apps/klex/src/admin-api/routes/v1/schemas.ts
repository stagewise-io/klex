import { extendZodWithOpenApi, z } from '@hono/zod-openapi';

import type { ModelId } from '@/config';

// Extend Zod with .openapi() metadata support for spec generation.
extendZodWithOpenApi(z);

// --- Shared ---

// `code` is machine-readable and stable; `error` is a human-readable message
// that may change wording at any time. Clients branch on `code`.
const errorResponseSchema = z
  .object({
    error: z.string(),
    code: z.string(),
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
  .enum([
    'connected',
    'connecting',
    'authorization_required',
    'authorizing',
    'error',
    'disconnected',
  ])
  .openapi('McpConnectionStatus');

// `state` and the authorization URL are deliberately absent: `state` is the only
// capability guarding the callback sink, and the authorization URL embeds it.
// They are returned exactly once, by `PUT .../authorization`.
const mcpServerAuthorizationSchema = z
  .object({
    id: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .openapi('McpServerAuthorization');

const mcpServerErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    at: z.string().datetime(),
  })
  .openapi('McpServerError');

const mcpServerInfoSchema = z
  .object({
    name: z.string(),
    status: mcpConnectionStatusSchema,
    toolCount: z.number().int().min(0),
    supportsPushNotifications: z.boolean(),
    supportsRealtimeMedia: z.boolean(),
    transport: z.enum(['stdio', 'http']),
    usesInteractiveOAuth: z.boolean(),
    authorization: mcpServerAuthorizationSchema.nullable(),
    lastError: mcpServerErrorSchema.nullable(),
    nextRetryAt: z.string().datetime().nullable(),
  })
  .openapi('McpServerInfo');

const mcpServersResponseSchema = z
  .object({
    servers: z.array(mcpServerInfoSchema),
  })
  .openapi('McpServersResponse');

const mcpServerResponseSchema = z
  .object({
    server: mcpServerInfoSchema,
  })
  .openapi('McpServerResponse');

const mcpVersionNegotiationSchema = z.union([
  z.enum(['legacy', 'auto']),
  z.object({ pin: z.string().min(1) }).strict(),
]);

const createMcpServerBodySchema = z
  .union([
    z
      .object({
        name: z.string().min(1),
        type: z.literal('stdio').optional(),
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        versionNegotiation: mcpVersionNegotiationSchema.optional(),
      })
      .strict(),
    z
      .object({
        name: z.string().min(1),
        type: z.enum(['http', 'streamable-http']).optional(),
        url: z.url(),
        headers: z.record(z.string(), z.string()).optional(),
        versionNegotiation: mcpVersionNegotiationSchema.optional(),
      })
      .strict(),
  ])
  .openapi('CreateMcpServerBody');

const updateMcpServerBodySchema = z
  .union([
    z
      .object({
        type: z.literal('stdio').optional(),
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        versionNegotiation: mcpVersionNegotiationSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(['http', 'streamable-http']).optional(),
        url: z.url(),
        headers: z.record(z.string(), z.string()).optional(),
        versionNegotiation: mcpVersionNegotiationSchema.optional(),
      })
      .strict(),
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

// The one response that carries `state` and the authorization URL: it goes to
// the caller that asked for the authorization, and nowhere else.
const mcpServerAuthorizationStartedSchema = z
  .object({
    id: z.string(),
    serverName: z.string(),
    serverUrl: z.url(),
    authorizationUrl: z.url(),
    state: z.string(),
    expiresAt: z.string().datetime(),
  })
  .openapi('McpServerAuthorizationStarted');

// Not `.strict()`: providers add benign extras to the redirect (`scope`, `iss`,
// `error_uri`), and rejecting the relayed callback with a 400 would leave the
// parked authorization to time out. Unknown keys are stripped instead.
const oauthCallbackBodySchema = z
  .object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    error_description: z.string().optional(),
  })
  .openapi('OAuthCallbackBody');

const oauthCallbackAcceptedSchema = z
  .object({
    accepted: z.literal(true),
  })
  .openapi('OAuthCallbackAccepted');

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

// --- Settings / Agent ---

const officialNameSchema = z.string().trim().min(2).max(128);

const agentIdentityResponseSchema = z
  .object({
    officialName: officialNameSchema,
  })
  .openapi('AgentIdentityResponse');

const agentIdentityPatchSchema = z
  .object({
    officialName: officialNameSchema,
  })
  .strict()
  .openapi('AgentIdentityPatch');

// --- Settings / Telemetry ---

const telemetryLevelSchema = z
  .enum(['off', 'minimum', 'reduced', 'full'])
  .openapi('TelemetryLevel');

const telemetrySettingsSchema = z
  .object({
    level: telemetryLevelSchema,
  })
  .openapi('TelemetrySettings');

const telemetrySettingsPatchSchema = z
  .object({
    level: telemetryLevelSchema.optional(),
  })
  .openapi('TelemetrySettingsPatch');

// --- Settings / Model Selection ---

const modelIdSchema = z
  .string()
  .regex(/^[^:]+:.+$/, {
    error:
      'Model ID must use the format providerId:modelId (preset) or providerId:endpointId:modelId (manual) with non-empty segments',
  })
  .openapi('ModelId') as z.ZodType<ModelId>;

const modelSelectionEntryOapiSchema = z
  .union([
    modelIdSchema,
    z
      .object({
        model: modelIdSchema,
        providerOptions: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  ])
  .openapi('ModelSelectionEntry');

const voiceModelSelectionSchema = z.object({
  sts: z.array(modelIdSchema),
  tts: z.array(modelIdSchema),
  stt: z.array(modelIdSchema),
});

const modelSelectionSchema = z
  .object({
    chat: z.array(modelSelectionEntryOapiSchema),
    compaction: z.array(modelSelectionEntryOapiSchema),
    memory: z.array(modelSelectionEntryOapiSchema),
    imageVision: z.array(modelSelectionEntryOapiSchema).default([]),
    audioListening: z.array(modelSelectionEntryOapiSchema).default([]),
    voice: voiceModelSelectionSchema,
  })
  .openapi('ModelSelection');

const modelSelectionPatchSchema = z
  .object({
    chat: z.array(modelSelectionEntryOapiSchema).optional(),
    compaction: z.array(modelSelectionEntryOapiSchema).optional(),
    memory: z.array(modelSelectionEntryOapiSchema).optional(),
    imageVision: z.array(modelSelectionEntryOapiSchema).optional(),
    audioListening: z.array(modelSelectionEntryOapiSchema).optional(),
    voice: voiceModelSelectionSchema.optional(),
  })
  .openapi('ModelSelectionPatch');

const modelSelectionWarningSchema = z
  .object({
    modelId: z.string(),
    message: z.string(),
  })
  .openapi('ModelSelectionWarning');

const modelSelectionPatchResponseSchema = modelSelectionSchema
  .extend({
    warnings: z.array(modelSelectionWarningSchema),
  })
  .openapi('ModelSelectionPatchResponse');

// --- Providers ---

const apiFormatSchema = z
  .enum([
    'openai',
    'anthropic',
    'google',
    'chat-completions',
    'open-responses',
    'messages',
    'realtime',
    'speech',
    'transcriptions',
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

const imageInputCapabilitySchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty(),
    maxBytes: z.number().int().positive(),
  })
  .strict()
  .openapi('ImageInputCapability');

const audioInputCapabilitySchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^audio\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty(),
    maxBytes: z.number().int().positive(),
  })
  .strict()
  .openapi('AudioInputCapability');

const modelInputCapabilitiesSchema = z
  .object({
    image: imageInputCapabilitySchema.optional(),
    audio: audioInputCapabilitySchema.optional(),
  })
  .strict()
  .openapi('ModelInputCapabilities');

const modelVoiceCapabilitiesSchema = z
  .object({
    sts: z.boolean().optional(),
    tts: z.boolean().optional(),
    stt: z.boolean().optional(),
  })
  .strict()
  .openapi('ModelVoiceCapabilities');

const modelCapabilitiesSchema = z
  .object({
    input: modelInputCapabilitiesSchema.optional(),
    voice: modelVoiceCapabilitiesSchema.optional(),
  })
  .strict()
  .openapi('ModelCapabilities');

const knownModelSchema = z
  .object({
    modelId: z.string().min(1),
    endpointName: z.string().optional(),
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
    capabilities: modelCapabilitiesSchema.optional(),
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
    capabilities: modelCapabilitiesSchema.optional(),
  })
  .refine(
    (d) =>
      d.displayName !== undefined ||
      d.contextSize !== undefined ||
      d.capabilities !== undefined,
    {
      message:
        'At least one of displayName, contextSize, or capabilities must be provided',
    },
  )
  .openapi('CreateKnownModelBody');

const updateKnownModelBodySchema = z
  .object({
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
    capabilities: modelCapabilitiesSchema.optional(),
  })
  .openapi('UpdateKnownModelBody');

const knownModelIdParamSchema = z.object({
  name: z.string().min(1),
  modelId: z.string().min(1),
});

const knownModelQuerySchema = z.object({
  endpointName: z.string().min(1).optional(),
});

// --- God Messages ---

const MAX_GOD_MESSAGE_BLOCKS = 16;
const MAX_GOD_MESSAGE_TEXT_LENGTH = 100_000;
const MAX_GOD_MESSAGE_MEDIA_LENGTH = 20_000_000;
const MAX_GOD_MESSAGE_URI_LENGTH = 2_048;
const MAX_GOD_MESSAGE_METADATA_LENGTH = 1_000;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const godMessageTextSchema = z.string().min(1).max(MAX_GOD_MESSAGE_TEXT_LENGTH);
const godMessageBase64Schema = z
  .string()
  .min(1)
  .max(MAX_GOD_MESSAGE_MEDIA_LENGTH)
  .regex(BASE64_PATTERN, 'Expected valid base64 data');

const godMessageTextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: godMessageTextSchema,
  })
  .openapi('GodMessageTextBlock');

const godMessageImageBlockSchema = z
  .object({
    type: z.literal('image'),
    mimeType: z.string().min(1).max(MAX_GOD_MESSAGE_METADATA_LENGTH),
    data: godMessageBase64Schema,
  })
  .openapi('GodMessageImageBlock');

const godMessageAudioBlockSchema = z
  .object({
    type: z.literal('audio'),
    mimeType: z.string().min(1).max(MAX_GOD_MESSAGE_METADATA_LENGTH),
    data: godMessageBase64Schema,
  })
  .openapi('GodMessageAudioBlock');

const godMessageResourceLinkBlockSchema = z
  .object({
    type: z.literal('resource_link'),
    uri: z.string().min(1).max(MAX_GOD_MESSAGE_URI_LENGTH),
    name: z.string().min(1).max(MAX_GOD_MESSAGE_METADATA_LENGTH),
    title: z.string().max(MAX_GOD_MESSAGE_METADATA_LENGTH).optional(),
    description: z.string().max(MAX_GOD_MESSAGE_TEXT_LENGTH).optional(),
    mimeType: z.string().max(MAX_GOD_MESSAGE_METADATA_LENGTH).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .openapi('GodMessageResourceLinkBlock');

const godMessageResourceBlockSchema = z
  .object({
    type: z.literal('resource'),
    resource: z
      .object({
        uri: z.string().min(1).max(MAX_GOD_MESSAGE_URI_LENGTH),
        mimeType: z.string().max(MAX_GOD_MESSAGE_METADATA_LENGTH).optional(),
        text: godMessageTextSchema.optional(),
        blob: godMessageBase64Schema.optional(),
      })
      .refine(
        (resource) =>
          (resource.text !== undefined) !== (resource.blob !== undefined),
        { message: 'Resource must contain exactly one of text or blob' },
      ),
  })
  .openapi('GodMessageResourceBlock');

const godMessageContentBlockSchema = z.union([
  godMessageTextBlockSchema,
  godMessageImageBlockSchema,
  godMessageAudioBlockSchema,
  godMessageResourceLinkBlockSchema,
  godMessageResourceBlockSchema,
]);

const createGodMessageBodySchema = z
  .object({
    content: z
      .array(godMessageContentBlockSchema)
      .min(1)
      .max(MAX_GOD_MESSAGE_BLOCKS),
  })
  .openapi('CreateGodMessageBody');

const createGodMessageResponseSchema = z
  .object({
    sessionId: z.string(),
  })
  .openapi('CreateGodMessageResponse');

// --- Usage ---

const usageSplitBySchema = z
  .enum(['none', 'model', 'provider', 'endpoint'])
  .describe('Dimension to split usage data by for grouping')
  .openapi('UsageSplitBy');

const usageGranularitySchema = z
  .enum(['event', 'hourly', 'daily', 'weekly'])
  .describe('Time granularity for usage data aggregation')
  .openapi('UsageGranularity');

const usageQuerySchema = z.object({
  splitBy: usageSplitBySchema
    .default('none')
    .describe(
      'Dimension to group results by: none, model, provider, or endpoint',
    ),
  from: z
    .string()
    .datetime({ offset: false })
    .optional()
    .describe(
      'Inclusive lower bound as UTC ISO 8601 datetime (no timezone offset)',
    ),
  to: z
    .string()
    .datetime({ offset: false })
    .optional()
    .describe(
      'Exclusive upper bound as UTC ISO 8601 datetime (no timezone offset)',
    ),
  granularity: usageGranularitySchema
    .default('daily')
    .describe(
      'Time bucket granularity: event (per-call), hourly, daily, or weekly',
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1000)
    .describe(
      'Maximum number of records to return (event granularity only; default 1000)',
    ),
});

const usageDataPointSchema = z
  .object({
    bucket: z
      .string()
      .nullable()
      .describe('Time bucket (ISO 8601). Null for event granularity.'),
    splitKey: z
      .string()
      .nullable()
      .describe(
        'Split dimension value (model ID, provider ID, or endpoint ID). Null when splitBy=none.',
      ),
    callCount: z
      .number()
      .int()
      .describe('Number of model calls in this bucket/split'),
    inputTokens: z.number().int().describe('Total input (prompt) tokens'),
    outputTokens: z.number().int().describe('Total output (completion) tokens'),
    inputCacheWriteTokens: z
      .number()
      .int()
      .describe('Total cache-write input tokens'),
    inputCacheReadTokens: z
      .number()
      .int()
      .describe('Total cache-read input tokens'),
    ttftMs: z
      .number()
      .nullable()
      .describe(
        'Time to first token in ms (actual for event granularity, average for aggregated)',
      ),
    totalDurationMs: z
      .number()
      .nullable()
      .describe(
        'Total duration in ms (actual for event granularity, average for aggregated)',
      ),
    errorCount: z
      .number()
      .int()
      .describe('Number of calls that resulted in an error'),
    // Event-level fields (null for aggregated granularities)
    id: z
      .string()
      .nullable()
      .describe('Record ID. Null for aggregated granularities.'),
    sessionId: z
      .string()
      .nullable()
      .describe('Session UUID. Null for aggregated granularities.'),
    providerId: z
      .string()
      .nullable()
      .describe('Provider ID. Null for aggregated granularities.'),
    endpointId: z
      .string()
      .nullable()
      .describe('Endpoint ID. Null for aggregated granularities.'),
    modelId: z
      .string()
      .nullable()
      .describe('Model ID. Null for aggregated granularities.'),
    source: z
      .enum(['chat', 'extension'])
      .nullable()
      .describe(
        'Call source: chat-session generation or extension-initiated. Null for aggregated granularities.',
      ),
    extensionId: z
      .string()
      .nullable()
      .describe(
        'Extension identifier. Null for aggregated granularities or non-extension calls.',
      ),
    finishReason: z
      .string()
      .nullable()
      .describe(
        'AI SDK finish reason (stop, tool-calls, error, aborted, etc.). Null for aggregated granularities.',
      ),
    errorType: z
      .string()
      .nullable()
      .describe(
        'Error type/name. Null for aggregated granularities or non-error calls.',
      ),
    startedAt: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 timestamp when the call started. Null for aggregated granularities.',
      ),
    finishedAt: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 timestamp when the call finished. Null for aggregated granularities.',
      ),
  })
  .openapi('UsageDataPoint');

const usageResponseSchema = z
  .object({
    dataPoints: z
      .array(usageDataPointSchema)
      .describe('Usage data points matching the query'),
  })
  .openapi('UsageResponse');

// --- Cloud ---

const cloudStatusResponseSchema = z
  .object({
    cloudEnabled: z.boolean(),
    enrolled: z.boolean(),
    clientId: z.string().nullable(),
    enrolledAt: z.string().nullable(),
    cloudBaseUrl: z.string(),
    tunnelState: z
      .enum(['disconnected', 'connecting', 'connected', 'error'])
      .describe('Tunnel connection state to Klex Cloud'),
  })
  .openapi('CloudStatusResponse');

const cloudEnrollBodySchema = z
  .object({
    enrollmentCode: z.string().min(1),
  })
  .openapi('CloudEnrollBody');

const cloudEnrollResponseSchema = z
  .object({
    clientId: z.string(),
    enrolledAt: z.string(),
  })
  .openapi('CloudEnrollResponse');

export {
  agentIdentityPatchSchema,
  agentIdentityResponseSchema,
  apiFormatSchema,
  audioInputCapabilitySchema,
  cloudEnrollBodySchema,
  cloudEnrollResponseSchema,
  cloudStatusResponseSchema,
  createEndpointBodySchema,
  createGodMessageBodySchema,
  createGodMessageResponseSchema,
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
  imageInputCapabilitySchema,
  introspectionChildSchema,
  introspectionNodeSchema,
  introspectionPathParamsSchema,
  knownModelIdParamSchema,
  knownModelQuerySchema,
  knownModelSchema,
  knownModelsResponseSchema,
  mcpServerAuthorizationSchema,
  mcpServerAuthorizationStartedSchema,
  mcpServerErrorSchema,
  mcpServerNameParamSchema,
  mcpServerResponseSchema,
  mcpServersResponseSchema,
  modelIdSchema,
  modelInputCapabilitiesSchema,
  modelSelectionPatchResponseSchema,
  modelSelectionPatchSchema,
  modelSelectionSchema,
  modelSelectionWarningSchema,
  oauthCallbackAcceptedSchema,
  oauthCallbackBodySchema,
  providerNameParamSchema,
  providerPresetSchema,
  providerResponseSchema,
  providersResponseSchema,
  telemetryLevelSchema,
  telemetrySettingsPatchSchema,
  telemetrySettingsSchema,
  toolCallHistoryResponseSchema,
  updateEndpointBodySchema,
  updateKnownModelBodySchema,
  updateMcpServerBodySchema,
  updateProviderBodySchema,
  usageDataPointSchema,
  usageGranularitySchema,
  usageQuerySchema,
  usageResponseSchema,
  usageSplitBySchema,
};
