import z from 'zod';
import { type $ZodType, toJSONSchema } from 'zod/v4/core';

const providerInstanceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    'Must not contain surrounding whitespace',
  );
const nativeModelIdSchema = z.string().min(1);
const modelIdSchema = nativeModelIdSchema;

const providerTypeSchema = z.enum([
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

const modelKindSchema = z.enum([
  'language',
  'speech-to-speech',
  'text-to-speech',
  'speech-to-text',
  'image-generation',
  'embedding',
  'reranking',
  'moderation',
  'unknown',
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

const providerSecretSettings = {
  'vercel-ai-gateway': ['apiKey'],
  'typesafe-ai': ['apiKey'],
  openai: ['apiKey'],
  anthropic: ['apiKey'],
  'google-gemini': ['apiKey'],
  'google-vertex': ['googleCredentials', 'apiKey'],
  'amazon-bedrock': ['secretAccessKey', 'sessionToken', 'apiKey'],
  'azure-openai': ['apiKey'],
  openrouter: ['apiKey'],
  moonshot: ['apiKey'],
  'alibaba-qwen': ['apiKey'],
  deepseek: ['apiKey'],
  zai: ['apiKey'],
  minimax: ['apiKey'],
  'xiaomi-mimo': ['apiKey'],
  mistral: ['apiKey'],
  xai: ['apiKey'],
  'glm-coding-plan': ['apiKey'],
  'minimax-coding-plan': ['apiKey'],
  'opencode-go': ['apiKey'],
  'opencode-zen': ['apiKey'],
  'chatgpt-codex-subscription': [],
  'chat-completions': ['apiKey'],
  responses: ['apiKey'],
  'anthropic-messages': ['apiKey'],
  'google-generative': ['apiKey'],
  ollama: [],
} satisfies Record<ProviderType, readonly string[]>;

function parseProviderSettings(
  type: ProviderType,
  input: unknown,
): Record<string, unknown> {
  return providerSettingsSchemas[type].parse(input);
}

function isProviderSecretSetting(type: ProviderType, key: string): boolean {
  return (
    key === 'headers' ||
    providerSecretSettings[type].some((item) => item === key)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function annotateSecretProperties(
  type: ProviderType,
  schema: Record<string, unknown>,
): void {
  if (isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (isProviderSecretSetting(type, key) && isRecord(property)) {
        property.writeOnly = true;
        property.format = 'password';
      }
    }
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    for (const alternative of alternatives) {
      if (isRecord(alternative)) annotateSecretProperties(type, alternative);
    }
  }
}

function getProviderSettingsJsonSchema(
  type: ProviderType,
): Record<string, unknown> {
  const schema = structuredClone(
    toJSONSchema(providerSettingsSchemas[type] as $ZodType, {
      unrepresentable: 'any',
    }),
  ) as Record<string, unknown>;
  annotateSecretProperties(type, schema);
  return schema;
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

type ProviderConfig = z.infer<typeof providerConfigSchema>;

const voiceModelSelectionSchema = z
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

const modelSelectionSchema = z
  .object({
    chat: z.array(modelSelectionEntrySchema).default([]),
    compaction: z.array(modelSelectionEntrySchema).default([]),
    memory: z.array(modelSelectionEntrySchema).default([]),
    imageVision: z.array(modelSelectionEntrySchema).default([]),
    audioListening: z.array(modelSelectionEntrySchema).default([]),
    consult: z.array(modelSelectionEntrySchema).default([]),
    voice: voiceModelSelectionSchema.default({ sts: [] }),
    instincts: z.array(instinctModelSelectionEntrySchema).default([]),
  })
  .strict();

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

/** Live application config, persisted schema version 7. */
const klexConfigSchema = z.object({
  configVersion: z.literal(2).default(2),
  officialName: z
    .string()
    .trim()
    .min(2)
    .transform((name) => Array.from(name).slice(0, 128).join(''))
    .default('Agent'),
  providers: z
    .record(providerInstanceIdSchema, providerConfigSchema)
    .default({}),
  modelSelection: modelSelectionSchema.prefault({}),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  timezone: timezoneSchema.default('UTC'),
  // `.prefault` (not `.default`) so nested defaults are applied.
  extensions: extensionsConfigSchema.prefault({}),
  sessionHistory: sessionHistoryConfigSchema.optional(),
  instinct: instinctConfigSchema.prefault({}),
});

type KlexConfig = z.infer<typeof klexConfigSchema>;
type SessionHistoryConfig = z.infer<typeof sessionHistoryConfigSchema>;
type EpisodeRotationConfig = z.infer<typeof episodeRotationConfigSchema>;

function parseKlexConfig(input: unknown): KlexConfig {
  return klexConfigSchema.parse(input);
}

export type {
  EpisodeRotationConfig,
  HttpServerConfig,
  InstinctConfig,
  InstinctModelSelectionEntry,
  KlexConfig,
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
  getProviderSettingsJsonSchema,
  instinctModelSelectionEntrySchema,
  isProviderSecretSetting,
  klexConfigSchema,
  mcpServerConfigSchema,
  modelCapabilitiesSchema,
  modelIdSchema,
  modelKindSchema,
  modelSelectionSchema,
  parseKlexConfig,
  parseProviderSettings,
  providerConfigSchema,
  providerInstanceIdSchema,
  providerTypeSchema,
  stsModelSelectionEntrySchema,
  timezoneSchema,
};
