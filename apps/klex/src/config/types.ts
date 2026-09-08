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
    httpReferer: environmentAwareUrlSchema.optional(),
    appName: z.string().min(1).optional(),
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
    testModelId: z.string().min(1).default('gpt-5-codex'),
  })
  .strict();

const providerSettingsSchemas = {
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

const legacyManualEndpointSchema = legacyEndpointConfigSchema.extend({
  knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
});

const legacyProviderConfigSchema = z.union([
  z
    .object({
      preset: legacyProviderPresetSchema,
      auth: legacyEndpointAuthSchema,
      knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
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

const modelSelectionSchema = z
  .object({
    chat: z.array(modelSelectionEntrySchema).default([]),
    compaction: z.array(modelSelectionEntrySchema).default([]),
    memory: z.array(modelSelectionEntrySchema).default([]),
    imageVision: z.array(modelSelectionEntrySchema).default([]),
    audioListening: z.array(modelSelectionEntrySchema).default([]),
    voice: voiceModelSelectionSchema.default({ sts: [], tts: [], stt: [] }),
  })
  .strict();

type ModelSelection = z.infer<typeof modelSelectionSchema>;
type ModelPurpose = Exclude<keyof ModelSelection, 'voice'>;
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

const telemetryLevelSchema = z.enum(['off', 'minimum', 'reduced', 'full']);

type TelemetryLevel = z.infer<typeof telemetryLevelSchema>;

const telemetryConfigSchema = z.object({
  level: telemetryLevelSchema,
});

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
  modelSelection: modelSelectionSchema.default({
    chat: [],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    voice: { sts: [], tts: [], stt: [] },
  }),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  telemetry: telemetryConfigSchema.optional(),
});

type KlexConfig = z.infer<typeof klexConfigSchema>;

const legacyModelSelectionSchema = z
  .object({
    chat: z.array(legacyModelSelectionEntrySchema).default([]),
    compaction: z.array(legacyModelSelectionEntrySchema).default([]),
    memory: z.array(legacyModelSelectionEntrySchema).default([]),
    imageVision: z.array(legacyModelSelectionEntrySchema).default([]),
    audioListening: z.array(legacyModelSelectionEntrySchema).default([]),
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
    voice: { sts: [], tts: [], stt: [] },
  });

const legacyKlexConfigSchema = z
  .object({
    officialName: z.string().trim().min(2).default('Agent'),
    providers: z
      .record(providerInstanceIdSchema, legacyProviderConfigSchema)
      .default({}),
    modelSelection: legacyModelSelectionSchema,
    mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
    telemetry: telemetryConfigSchema.optional(),
  })
  .strict();

const currentStoredKlexConfigSchema = klexConfigSchema
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

function parseCurrentStoredKlexConfig(input: unknown): KlexConfig {
  return currentStoredKlexConfigSchema.parse(input);
}

function migrateLegacyKlexConfig(input: unknown): KlexConfig {
  return migrateLegacyConfig(parseLegacyKlexConfig(input));
}

function migrateLegacyConfig(legacy: LegacyKlexConfig): KlexConfig {
  const providers: KlexConfig['providers'] = {};
  const providerIds = new Map<string, Map<string | undefined, string>>();
  for (const [oldProviderId, provider] of Object.entries(legacy.providers)) {
    const ids = new Map<string | undefined, string>();
    if ('preset' in provider) {
      addMigratedProvider(providers, oldProviderId, {
        type: provider.preset === 'google' ? 'google-gemini' : provider.preset,
        settings: legacySettings(provider.auth),
        knownModels: provider.knownModels,
      });
      ids.set(undefined, oldProviderId);
    } else {
      const entries = Object.entries(provider.endpoints);
      for (const [endpointId, endpoint] of entries) {
        const instanceId =
          entries.length === 1
            ? oldProviderId
            : `${oldProviderId}--${endpointId}`;
        addMigratedProvider(providers, instanceId, {
          type: legacyFormatProviderType(endpoint.format),
          settings: {
            baseUrl: endpoint.url,
            ...legacySettings(endpoint.auth),
          },
          knownModels: endpoint.knownModels,
        });
        ids.set(endpointId, instanceId);
      }
    }
    providerIds.set(oldProviderId, ids);
  }

  const migrateList = (entries: readonly LegacyModelEntry[]) =>
    entries.map((entry) =>
      migrateLegacyModelEntry(entry, legacy.providers, providerIds),
    );
  const selection = legacy.modelSelection;
  return klexConfigSchema.parse({
    configVersion: 2,
    officialName: legacy.officialName,
    providers,
    modelSelection: {
      chat: migrateList(selection.chat),
      compaction: migrateList(selection.compaction),
      memory: migrateList(selection.memory),
      imageVision: migrateList(selection.imageVision),
      audioListening: migrateList(selection.audioListening),
      voice: {
        sts: migrateList(selection.voice.sts),
        tts: migrateList(selection.voice.tts),
        stt: migrateList(selection.voice.stt),
      },
    },
    mcpServers: legacy.mcpServers,
    telemetry: legacy.telemetry,
  });
}

function migrateLegacyModelEntry(
  entry: LegacyModelEntry,
  providers: Record<string, LegacyProviderConfig>,
  providerIds: ReadonlyMap<string, ReadonlyMap<string | undefined, string>>,
): ModelSelectionEntry {
  const encoded = typeof entry === 'string' ? entry : entry.model;
  const separator = encoded.indexOf(':');
  const oldProviderId = encoded.slice(0, separator);
  const remainder = encoded.slice(separator + 1);
  const provider = providers[oldProviderId];
  const ids = providerIds.get(oldProviderId);
  if (!provider || !ids)
    throw new Error(
      `Unknown provider '${oldProviderId}' in legacy model reference`,
    );

  let providerId: string | undefined;
  let modelId = remainder;
  if ('preset' in provider) {
    providerId = ids.get(undefined);
  } else {
    const endpointSeparator = remainder.indexOf(':');
    if (endpointSeparator === -1) {
      throw new Error(
        `Legacy model reference '${encoded}' is missing an endpoint`,
      );
    }
    const endpointId = remainder.slice(0, endpointSeparator);
    providerId = ids.get(endpointId);
    modelId = remainder.slice(endpointSeparator + 1);
  }
  if (!providerId || !modelId)
    throw new Error(`Invalid legacy model reference '${encoded}'`);
  return {
    providerId,
    modelId,
    ...(typeof entry === 'object' && entry.providerOptions
      ? { providerOptions: entry.providerOptions }
      : {}),
  };
}

function addMigratedProvider(
  providers: KlexConfig['providers'],
  providerId: string,
  provider: ProviderConfig,
): void {
  if (providers[providerId]) {
    throw new Error(`Provider migration ID collision at '${providerId}'`);
  }
  providers[providerId] = provider;
}

function legacySettings(auth: LegacyEndpointAuth): Record<string, unknown> {
  return {
    ...(auth.apiKey !== undefined && {
      apiKey: migrateLegacyEnvironmentReferences(auth.apiKey),
    }),
    ...(auth.headers !== undefined && {
      headers: Object.fromEntries(
        Object.entries(auth.headers).map(([key, value]) => [
          key,
          migrateLegacyEnvironmentReferences(value),
        ]),
      ),
    }),
  };
}

function migrateLegacyEnvironmentReferences(value: string): string {
  return value.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}');
}

function legacyFormatProviderType(format: ApiFormat): ProviderType {
  switch (format) {
    case 'openai':
      return 'openai';
    case 'chat-completions':
      return 'chat-completions';
    case 'anthropic':
    case 'messages':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative';
    case 'open-responses':
      return 'responses';
    case 'realtime':
    case 'speech':
    case 'transcriptions':
      return 'openai';
  }
}

export type {
  HttpServerConfig,
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
  StdioServerConfig,
  TelemetryLevel,
  VoiceModelPurpose,
};
export {
  getProviderSettingsJsonSchema,
  isProviderSecretSetting,
  klexConfigSchema,
  mcpServerConfigSchema,
  migrateLegacyKlexConfig,
  modelCapabilitiesSchema,
  modelIdSchema,
  modelKindSchema,
  modelSelectionSchema,
  parseCurrentStoredKlexConfig,
  parseKlexConfig,
  parseLegacyKlexConfig,
  parseProviderSettings,
  providerConfigSchema,
  providerInstanceIdSchema,
  providerTypeSchema,
  telemetryLevelSchema,
};
