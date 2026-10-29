// Frozen snapshot of config schemas 1–7 from v0.27.1. Never edit in place.
import z from 'zod';

const providerInstanceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    'Must not contain surrounding whitespace',
  );
const nativeModelIdSchema = z.string().min(1);
const modelIdSchema = nativeModelIdSchema;

const historicalProviderTypeSchema = z.enum([
  'openai',
  'anthropic',
  'google-gemini',
  'google-vertex',
  'amazon-bedrock',
  'azure-openai',
  'openrouter',
  'moonshot',
  'alibaba-qwen',
  'deepseek',
  'zai',
  'minimax',
  'xiaomi-mimo',
  'mistral',
  'xai',
  'glm-coding-plan',
  'minimax-coding-plan',
  'opencode-go',
  'opencode-zen',
  'chatgpt-codex-subscription',
  'chat-completions',
  'responses',
  'anthropic-messages',
  'google-generative',
  'ollama',
]);
const providerTypeSchema = z.enum([
  ...historicalProviderTypeSchema.options,
  'typesafe-ai',
  'vercel-ai-gateway',
]);
type ProviderType = z.infer<typeof providerTypeSchema>;

const modelSelectionEntrySchema = z
  .object({
    providerId: providerInstanceIdSchema,
    modelId: nativeModelIdSchema,
    providerOptions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();

const stsModelSelectionEntrySchema = modelSelectionEntrySchema.extend({
  voiceId: z
    .string()
    .min(1)
    .refine(
      (value) => value.trim() === value,
      'Must not contain surrounding whitespace',
    )
    .optional(),
});
type StsModelSelectionEntry = z.infer<typeof stsModelSelectionEntrySchema>;
const instinctModelSelectionEntrySchema = modelSelectionEntrySchema.extend({
  api: z.enum(['generation', 'evaluation']).default('generation'),
  attemptTimeoutMs: z.number().int().positive().max(120_000).optional(),
});
type InstinctModelSelectionEntry = z.infer<
  typeof instinctModelSelectionEntrySchema
>;
type ModelSelectionEntry = z.infer<typeof modelSelectionEntrySchema>;
type ModelId = string;

// Legacy v1 transport types are private migration input only.

const apiFormatSchema = z.enum([
  // Direct vendor providers
  'openai', // used for full OpenAI API
  'anthropic', // used for full Anthropic API
  'google', // used for full Google API

  // Standardized formats for individual functionalities
  'chat-completions', // used for OpenAI-compatible chat completions endpoints
  'open-responses', // used for OpenAI-compatible responses endpoints
  'messages', // used for Anthropic-compatible messages endpoints

  // Standardized voice API formats
  'realtime', // used for OpenAI-compatible persistent Realtime endpoints
  'speech', // used for OpenAI-compatible text-to-speech endpoints
  'transcriptions', // used for OpenAI-compatible speech-to-text endpoints
]);

type ApiFormat = z.infer<typeof apiFormatSchema>;

// Endpoint auth: apiKey (literal or {env:VAR}) plus optional custom headers

const legacyEndpointAuthSchema = z.object({
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type LegacyEndpointAuth = z.infer<typeof legacyEndpointAuthSchema>;

// Endpoint config

const legacyEndpointConfigSchema = z.object({
  url: z.url(),
  format: apiFormatSchema,
  auth: legacyEndpointAuthSchema,
});

// Provider preset: a named bundle of endpoint URL and format

const legacyProviderPresetSchema = z.enum(['openai', 'anthropic', 'google']);

// Model definition: optional per-model metadata inside a provider

const imageInputCapabilitySchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty()
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    /** Max image width in pixels. undefined = no limit. Default: 2048. */
    maxWidth: z.number().int().positive().optional(),
    /** Max image height in pixels. undefined = no limit. Default: 2048. */
    maxHeight: z.number().int().positive().optional(),
    /** Max total pixel count (width × height). undefined = no limit. */
    maxTotalPixels: z.number().int().positive().optional(),
  })
  .strict();

const audioInputCapabilitySchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^audio\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty()
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    maxLengthSeconds: z.number().int().positive().optional(),
  })
  .strict();

const historicalModelKindSchema = z.enum([
  'language',
  'speech-to-speech',
  'text-to-speech',
  'speech-to-text',
  'image-generation',
  'embedding',
  'reranking',
  'moderation',
  'unknown',
]);

const modelKindSchema = z.enum([
  ...historicalModelKindSchema.options,
  'evaluation',
]);

const modelInputCapabilitiesSchema = z
  .object({
    image: imageInputCapabilitySchema.optional(),
    audio: audioInputCapabilitySchema.optional(),
  })
  .strict();

const modelVoiceCapabilitiesSchema = z
  .object({
    /** Supports native persistent speech-to-speech conversation. */
    sts: z.boolean().optional(),
    /** Supports synthesizing spoken audio from text. */
    tts: z.boolean().optional(),
    /** Supports transcribing spoken audio to text. */
    stt: z.boolean().optional(),
  })
  .strict();

const modelCapabilitiesSchema = z
  .object({
    input: modelInputCapabilitiesSchema.optional(),
    voice: modelVoiceCapabilitiesSchema.optional(),
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();

const modelDefinitionSchema = z
  .object({
    kind: modelKindSchema.optional(),
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
    capabilities: modelCapabilitiesSchema.optional(),
  })
  .strict();

const historicalModelDefinitionSchema = modelDefinitionSchema.extend({
  kind: historicalModelKindSchema.optional(),
});
type ModelKind = z.infer<typeof modelKindSchema>;
type ModelInputCapabilities = z.infer<typeof modelInputCapabilitiesSchema>;
type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
type ModelVoiceCapabilities = z.infer<typeof modelVoiceCapabilitiesSchema>;
type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

const environmentPlaceholderPattern = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const environmentAwareUrlSchema = z.string().refine((value) => {
  if (environmentPlaceholderPattern.test(value)) return true;
  try {
    new URL(value.replace(/\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/g, 'value'));
    return true;
  } catch {
    return false;
  }
}, 'Invalid URL');
const environmentPlaceholderSchema = z
  .string()
  .regex(environmentPlaceholderPattern);
const jsonCredentialSchema = z.string().refine((value) => {
  if (environmentPlaceholderSchema.safeParse(value).success) return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed);
  } catch {
    return false;
  }
}, 'Must be a JSON object or environment reference');

const apiKeySettingsSchema = z.object({ apiKey: z.string().min(1) }).strict();
const openAiSettingsSchema = apiKeySettingsSchema
  .extend({
    baseUrl: environmentAwareUrlSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const openRouterSettingsSchema = apiKeySettingsSchema
  .extend({
    httpReferer: environmentAwareUrlSchema.optional().meta({ readOnly: true }),
    appName: z.string().min(1).optional().meta({ readOnly: true }),
  })
  .strict();
const compatibleEndpointSettingsSchema = z
  .object({
    baseUrl: environmentAwareUrlSchema,
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    testModelId: z.string().min(1).optional(),
  })
  .strict();
const ollamaSettingsSchema = z
  .object({
    baseUrl: environmentAwareUrlSchema.default('http://127.0.0.1:11434/v1'),
  })
  .strict();
const azureOpenAiSettingsSchema = z
  .object({
    apiKey: z.string().min(1),
    resourceName: z.string().min(1).optional(),
    baseUrl: environmentAwareUrlSchema.optional(),
    testModelId: z.string().min(1).optional(),
    apiVersion: z.string().min(1).optional(),
    useDeploymentBasedUrls: z.boolean().default(false),
  })
  .strict()
  .refine((settings) => settings.resourceName || settings.baseUrl, {
    message: 'Either resourceName or baseUrl is required',
  })
  .refine(
    (settings) =>
      !settings.useDeploymentBasedUrls ||
      (typeof settings.apiVersion === 'string' &&
        /^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(settings.apiVersion)),
    {
      message:
        'Deployment-based URLs require an explicit date-based API version',
      path: ['apiVersion'],
    },
  );
const bedrockCommonSettings = {
  region: z.string().min(1).default('us-east-1'),
  testModelId: z.string().min(1).optional(),
};
const amazonBedrockSettingsSchema = z.discriminatedUnion('authMode', [
  z
    .object({ ...bedrockCommonSettings, authMode: z.literal('default-chain') })
    .strict(),
  z
    .object({
      ...bedrockCommonSettings,
      authMode: z.literal('access-keys'),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...bedrockCommonSettings,
      authMode: z.literal('api-key'),
      apiKey: z.string().min(1),
    })
    .strict(),
]);
const vertexCommonSettings = {
  project: z.string().min(1).optional(),
  location: z.string().min(1).default('us-central1'),
  testModelId: z.string().min(1).optional(),
};
const googleVertexSettingsSchema = z.discriminatedUnion('authMode', [
  z.object({ ...vertexCommonSettings, authMode: z.literal('adc') }).strict(),
  z
    .object({
      ...vertexCommonSettings,
      authMode: z.literal('service-account'),
      googleCredentials: jsonCredentialSchema,
    })
    .strict(),
  z
    .object({
      ...vertexCommonSettings,
      authMode: z.literal('api-key'),
      apiKey: z.string().min(1),
    })
    .strict(),
]);
const codexSubscriptionSettingsSchema = z
  .object({
    codexExecutable: z.string().min(1).default('codex'),
    authFile: z.string().min(1).optional(),
    baseUrl: environmentAwareUrlSchema.optional(),
    testModelId: z.string().min(1).optional().meta({ readOnly: true }),
  })
  .strict();

const vercelAiGatewaySettingsSchema = openAiSettingsSchema.extend({
  teamIdOrSlug: z.string().min(1).optional(),
});

const providerSettingsSchemas = {
  'vercel-ai-gateway': vercelAiGatewaySettingsSchema,
  'typesafe-ai': openAiSettingsSchema,
  openai: openAiSettingsSchema,
  anthropic: apiKeySettingsSchema,
  'google-gemini': apiKeySettingsSchema,
  'google-vertex': googleVertexSettingsSchema,
  'amazon-bedrock': amazonBedrockSettingsSchema,
  'azure-openai': azureOpenAiSettingsSchema,
  openrouter: openRouterSettingsSchema,
  moonshot: apiKeySettingsSchema,
  'alibaba-qwen': apiKeySettingsSchema,
  deepseek: apiKeySettingsSchema,
  zai: apiKeySettingsSchema,
  minimax: apiKeySettingsSchema,
  'xiaomi-mimo': apiKeySettingsSchema,
  mistral: apiKeySettingsSchema,
  xai: apiKeySettingsSchema,
  'glm-coding-plan': apiKeySettingsSchema,
  'minimax-coding-plan': apiKeySettingsSchema,
  'opencode-go': apiKeySettingsSchema,
  'opencode-zen': apiKeySettingsSchema,
  'chatgpt-codex-subscription': codexSubscriptionSettingsSchema,
  'chat-completions': compatibleEndpointSettingsSchema,
  responses: compatibleEndpointSettingsSchema,
  'anthropic-messages': compatibleEndpointSettingsSchema,
  'google-generative': compatibleEndpointSettingsSchema,
  ollama: ollamaSettingsSchema,
} satisfies Record<ProviderType, z.ZodType<Record<string, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProviderSettings(
  type: ProviderType,
  input: unknown,
): Record<string, unknown> {
  return providerSettingsSchemas[type].parse(input);
}

const providerConfigSchema = z
  .object({
    type: providerTypeSchema,
    settings: z.record(z.string(), z.unknown()).default({}),
    knownModels: z.record(z.string().min(1), modelDefinitionSchema).optional(),
  })
  .strict()
  .transform((provider) => ({
    ...provider,
    settings: parseProviderSettings(provider.type, provider.settings),
  }));

const historicalProviderConfigSchema = z
  .object({
    type: historicalProviderTypeSchema,
    settings: z.record(z.string(), z.unknown()).default({}),
    knownModels: z
      .record(z.string().min(1), historicalModelDefinitionSchema)
      .optional(),
  })
  .strict()
  .transform((provider) => ({
    ...provider,
    settings: parseProviderSettings(provider.type, provider.settings),
  }));

type ProviderConfig = z.infer<typeof providerConfigSchema>;

const legacyManualEndpointSchema = legacyEndpointConfigSchema.extend({
  knownModels: z.record(z.string(), historicalModelDefinitionSchema).optional(),
});

const legacyProviderConfigSchema = z.union([
  z
    .object({
      preset: legacyProviderPresetSchema,
      auth: legacyEndpointAuthSchema,
      knownModels: z
        .record(z.string(), historicalModelDefinitionSchema)
        .optional(),
    })
    .strict(),
  z
    .object({ endpoints: z.record(z.string(), legacyManualEndpointSchema) })
    .strict(),
]);

const legacyModelSelectionEntrySchema = z.union([
  z.string().regex(/^[^:]+:.+$/),
  z
    .object({
      model: z.string().regex(/^[^:]+:.+$/),
      providerOptions: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional(),
    })
    .strict(),
]);

const voiceModelSelectionSchema = z
  .object({
    sts: z.array(modelSelectionEntrySchema).default([]),
    tts: z.array(modelSelectionEntrySchema).default([]),
    stt: z.array(modelSelectionEntrySchema).default([]),
  })
  .strict();

const v5VoiceModelSelectionSchema = voiceModelSelectionSchema.extend({
  sts: z.array(stsModelSelectionEntrySchema).default([]),
});

const currentVoiceModelSelectionSchema = z
  .object({ sts: z.array(stsModelSelectionEntrySchema).default([]) })
  .strict();

export const MODEL_PURPOSES = [
  'chat',
  'compaction',
  'memory',
  'imageVision',
  'audioListening',
  'consult',
  'instincts',
] as const;

const historicalModelSelectionSchema = z
  .object({
    chat: z.array(modelSelectionEntrySchema).default([]),
    compaction: z.array(modelSelectionEntrySchema).default([]),
    memory: z.array(modelSelectionEntrySchema).default([]),
    imageVision: z.array(modelSelectionEntrySchema).default([]),
    audioListening: z.array(modelSelectionEntrySchema).default([]),
    consult: z.array(modelSelectionEntrySchema).default([]),
    voice: voiceModelSelectionSchema.default({ sts: [], tts: [], stt: [] }),
  })
  .strict();

const v5ModelSelectionSchema = historicalModelSelectionSchema.extend({
  voice: v5VoiceModelSelectionSchema.default({
    sts: [],
    tts: [],
    stt: [],
  }),
});

const modelSelectionSchema = historicalModelSelectionSchema.extend({
  voice: currentVoiceModelSelectionSchema.default({
    sts: [],
  }),
  instincts: z.array(instinctModelSelectionEntrySchema).default([]),
});

type ModelSelection = z.infer<typeof modelSelectionSchema>;
type InstinctConfig = z.infer<typeof instinctConfigSchema>;
type ModelPurpose = (typeof MODEL_PURPOSES)[number];
type VoiceModelPurpose = keyof ModelSelection['voice'];

// MCP server config (standard mcp.json shape)

const mcpVersionNegotiationSchema = z.union([
  z.enum(['legacy', 'auto']),
  z.object({ pin: z.string().min(1) }).strict(),
]);

type McpVersionNegotiation = z.infer<typeof mcpVersionNegotiationSchema>;

const stdioServerConfigSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    versionNegotiation: mcpVersionNegotiationSchema.optional(),
  })
  .strict();

type StdioServerConfig = z.infer<typeof stdioServerConfigSchema>;

const httpServerConfigSchema = z
  .object({
    type: z.enum(['http', 'streamable-http']).optional(),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    versionNegotiation: mcpVersionNegotiationSchema.optional(),
  })
  .strict();

type HttpServerConfig = z.infer<typeof httpServerConfigSchema>;

const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  httpServerConfigSchema,
]);

type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Stored schemas 1–3 may carry a `telemetry` object from before telemetry
 * moved to CLI/env configuration. Those historical schemas accept it without
 * interpreting it; the 3→4 migration drops it and schema 4 rejects it.
 */
const removedTelemetryFieldSchema = z.unknown().optional();

const timezoneSchema = z
  .string()
  .trim()
  .refine(
    (timezone) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Timezone must be a valid IANA identifier' },
  );

/**
 * Tunables of the step instinct phase (shared classification and
 * extension reactions before model generation). All fields have defaults.
 */
const instinctConfigSchema = z
  .object({
    /** Kill switch. When false, steps never run instinct. */
    enabled: z.boolean().default(true),
    /** Shared deadline for classification plus all reactions. */
    timeoutMs: z.number().int().positive().max(120_000).default(8_000),
    /** Deadline of the classifier call alone (bounded by `timeoutMs`). */
    classifierTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(4_000),
    /** Character budget for the last five messages together. */
    historyCharacterCap: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .default(16_000),
    /** Maximum rendered length of one message. */
    messageCharacterCap: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .default(2_000),
    /** Maximum length of one extension's `context`. */
    contextCharacterCap: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .default(2_000),
  })
  .strict();

/**
 * Frozen shape of stored config schemas 2–4. Historical validation and
 * migrations (1→2, 3→4) use it so they keep producing the shape that
 * schema 4 accepts. Do not change it; evolve `klexConfigSchema` instead.
 */
const klexConfigV4Schema = z.object({
  configVersion: z.literal(2).default(2),
  episodeFinishIdleTriggerTimeMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(300_000),
  memoryWriteIntervalMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(60_000),
  memoryWriteStepInterval: z.number().int().positive().default(3),
  officialName: z
    .string()
    .trim()
    .min(2)
    .transform((name) => Array.from(name).slice(0, 128).join(''))
    .default('Agent'),
  providers: z
    .record(providerInstanceIdSchema, historicalProviderConfigSchema)
    .default({}),
  modelSelection: historicalModelSelectionSchema.default({
    chat: [],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    consult: [],
    voice: { sts: [], tts: [], stt: [] },
  }),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timezone: timezoneSchema.default('UTC'),
});

type KlexConfigV4 = z.infer<typeof klexConfigV4Schema>;

const MAX_TIMER_MS = 2_147_483_647;

/** Episode rotation limits of the memory extension. */
const episodeRotationConfigSchema = z
  .object({
    maxCharacters: z.number().int().positive().default(50_000),
    maxDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMER_MS)
      .default(3_600_000),
    idleTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMER_MS)
      .default(600_000),
  })
  .strict();

const memoryExtensionConfigSchema = z
  .object({ episodes: episodeRotationConfigSchema.prefault({}) })
  .strict();

/**
 * Minimum accepted session-history size cap (16 MiB). Smaller caps would
 * evict the live transcript almost immediately.
 */
export const MIN_SESSION_HISTORY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Optional session-history overrides. Intentionally has no default so the
 * key is never written to `config.json` unless a user sets it.
 */
const sessionHistoryConfigSchema = z
  .object({
    maxBytes: z.number().int().min(MIN_SESSION_HISTORY_MAX_BYTES).optional(),
  })
  .strict();

/** Extension behavior settings, keyed by extension. */
const extensionsConfigSchema = z
  .object({ memory: memoryExtensionConfigSchema.prefault({}) })
  .strict();

/** Frozen released schema 5: memory extensions and voice selection, no instinct. */
const klexConfigV5Schema = z.object({
  configVersion: z.literal(2).default(2),
  officialName: z
    .string()
    .trim()
    .min(2)
    .transform((name) => Array.from(name).slice(0, 128).join(''))
    .default('Agent'),
  providers: z
    .record(providerInstanceIdSchema, historicalProviderConfigSchema)
    .default({}),
  modelSelection: v5ModelSelectionSchema.default({
    chat: [],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    consult: [],
    voice: { sts: [], tts: [], stt: [] },
  }),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timezone: timezoneSchema.default('UTC'),
  // `.prefault` (not `.default`) so nested defaults are applied.
  extensions: extensionsConfigSchema.prefault({}),
  sessionHistory: sessionHistoryConfigSchema.optional(),
});

/** Frozen released schema 6: instinct backends with all three voice lists. */
const klexConfigV6Schema = klexConfigV5Schema.extend({
  instinct: instinctConfigSchema.prefault({}),
  providers: z
    .record(providerInstanceIdSchema, providerConfigSchema)
    .default({}),
  modelSelection: v5ModelSelectionSchema
    .extend({
      instincts: z.array(instinctModelSelectionEntrySchema).default([]),
    })
    .prefault({}),
});

const klexConfigSchema = klexConfigV6Schema.extend({
  modelSelection: modelSelectionSchema.prefault({}),
});

type KlexConfig = z.infer<typeof klexConfigSchema>;
type SessionHistoryConfig = z.infer<typeof sessionHistoryConfigSchema>;
type EpisodeRotationConfig = z.infer<typeof episodeRotationConfigSchema>;

const legacyModelSelectionSchema = z
  .object({
    chat: z.array(legacyModelSelectionEntrySchema).default([]),
    compaction: z.array(legacyModelSelectionEntrySchema).default([]),
    memory: z.array(legacyModelSelectionEntrySchema).default([]),
    imageVision: z.array(legacyModelSelectionEntrySchema).default([]),
    audioListening: z.array(legacyModelSelectionEntrySchema).default([]),
    consult: z.array(legacyModelSelectionEntrySchema).default([]),
    voice: z
      .object({
        sts: z.array(z.string()).default([]),
        tts: z.array(z.string()).default([]),
        stt: z.array(z.string()).default([]),
      })
      .default({ sts: [], tts: [], stt: [] }),
  })
  .default({
    chat: [],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    consult: [],
    voice: { sts: [], tts: [], stt: [] },
  });

const legacyKlexConfigSchema = z
  .object({
    episodeFinishIdleTriggerTimeMs: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(300_000),
    officialName: z.string().trim().min(2).default('Agent'),
    providers: z
      .record(providerInstanceIdSchema, legacyProviderConfigSchema)
      .default({}),
    modelSelection: legacyModelSelectionSchema,
    mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
    telemetry: removedTelemetryFieldSchema,
  })
  .strict();

/** Stored schemas 2 and 3: the v4 config shape plus the removed `telemetry`. */
const storedKlexConfigV2Schema = klexConfigV4Schema
  .extend({
    configVersion: z.literal(2),
    telemetry: removedTelemetryFieldSchema,
  })
  .strict();

/** Stored schema 4: root memory keys, no `extensions`. */
const storedKlexConfigV4Schema = klexConfigV4Schema
  .extend({ configVersion: z.literal(2) })
  .strict();

const storedKlexConfigV5Schema = klexConfigV5Schema
  .extend({ configVersion: z.literal(2) })
  .strict();

const storedKlexConfigV6Schema = klexConfigV6Schema
  .extend({ configVersion: z.literal(2) })
  .strict();

/** Stored schema 7: STS-only voice selection. */
const storedKlexConfigSchema = klexConfigSchema
  .extend({ configVersion: z.literal(2) })
  .strict();

type LegacyKlexConfig = z.infer<typeof legacyKlexConfigSchema>;
type LegacyProviderConfig = z.infer<typeof legacyProviderConfigSchema>;
type LegacyModelEntry = z.infer<typeof legacyModelSelectionEntrySchema>;

function parseKlexConfig(input: unknown): KlexConfig {
  return klexConfigSchema.parse(input);
}

function parseLegacyKlexConfig(input: unknown): LegacyKlexConfig {
  return legacyKlexConfigSchema.parse(input);
}

function parseStoredKlexConfigV2(input: unknown): Record<string, unknown> {
  return storedKlexConfigV2Schema.parse(input);
}

function parseStoredKlexConfigV4(input: unknown): Record<string, unknown> {
  return storedKlexConfigV4Schema.parse(input);
}

function parseStoredKlexConfigV5(input: unknown): Record<string, unknown> {
  return storedKlexConfigV5Schema.parse(input);
}

function parseStoredKlexConfigV6(input: unknown): Record<string, unknown> {
  return storedKlexConfigV6Schema.parse(input);
}

function parseStoredKlexConfig(input: unknown): Record<string, unknown> {
  return storedKlexConfigSchema.parse(input);
}

export type {
  ApiFormat,
  EpisodeRotationConfig,
  HttpServerConfig,
  InstinctConfig,
  InstinctModelSelectionEntry,
  KlexConfig,
  KlexConfigV4,
  LegacyEndpointAuth,
  LegacyKlexConfig,
  LegacyModelEntry,
  LegacyProviderConfig,
  McpServerConfig,
  McpVersionNegotiation,
  ModelCapabilities,
  ModelDefinition,
  ModelId,
  ModelInputCapabilities,
  ModelKind,
  ModelPurpose,
  ModelSelection,
  ModelSelectionEntry,
  ModelVoiceCapabilities,
  ProviderConfig,
  ProviderType,
  SessionHistoryConfig,
  StdioServerConfig,
  StsModelSelectionEntry,
  VoiceModelPurpose,
};
export {
  instinctModelSelectionEntrySchema,
  klexConfigSchema,
  klexConfigV4Schema,
  klexConfigV5Schema,
  klexConfigV6Schema,
  mcpServerConfigSchema,
  modelCapabilitiesSchema,
  modelIdSchema,
  modelKindSchema,
  modelSelectionSchema,
  parseKlexConfig,
  parseLegacyKlexConfig,
  parseStoredKlexConfig,
  parseStoredKlexConfigV2,
  parseStoredKlexConfigV4,
  parseStoredKlexConfigV5,
  parseStoredKlexConfigV6,
  providerConfigSchema,
  providerInstanceIdSchema,
  providerTypeSchema,
  storedKlexConfigV2Schema,
  storedKlexConfigV4Schema,
  storedKlexConfigV5Schema,
  storedKlexConfigV6Schema,
  stsModelSelectionEntrySchema,
  timezoneSchema,
};
