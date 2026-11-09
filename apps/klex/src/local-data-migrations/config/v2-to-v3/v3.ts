import { z } from 'zod';

const providerIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    'Must not contain surrounding whitespace',
  );
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
    providerId: providerIdSchema,
    modelId: z.string().min(1),
    providerOptions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
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
const imageInputSchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty()
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    maxWidth: z.number().int().positive().optional(),
    maxHeight: z.number().int().positive().optional(),
    maxTotalPixels: z.number().int().positive().optional(),
  })
  .strict();
const audioInputSchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^audio\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty()
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    maxLengthSeconds: z.number().int().positive().optional(),
  })
  .strict();
const modelDefinitionSchema = z
  .object({
    kind: modelKindSchema.optional(),
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
    capabilities: z
      .object({
        input: z
          .object({
            image: imageInputSchema.optional(),
            audio: audioInputSchema.optional(),
          })
          .strict()
          .optional(),
        voice: z
          .object({
            sts: z.boolean().optional(),
            tts: z.boolean().optional(),
            stt: z.boolean().optional(),
          })
          .strict()
          .optional(),
        tools: z.boolean().optional(),
        reasoning: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const environmentReferencePattern = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const urlSchema = z.string().refine((value) => {
  if (environmentReferencePattern.test(value)) return true;
  try {
    new URL(value.replace(/\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/g, 'value'));
    return true;
  } catch {
    return false;
  }
}, 'Invalid URL');
const jsonCredentialSchema = z.string().refine((value) => {
  if (environmentReferencePattern.test(value)) return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}, 'Must be a JSON object or environment reference');
const apiKeySettingsSchema = z.object({ apiKey: z.string().min(1) }).strict();
const openAiSettingsSchema = apiKeySettingsSchema
  .extend({
    baseUrl: urlSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const openRouterSettingsSchema = apiKeySettingsSchema
  .extend({
    httpReferer: urlSchema.optional().meta({ readOnly: true }),
    appName: z.string().min(1).optional().meta({ readOnly: true }),
  })
  .strict();
const endpointSettingsSchema = z
  .object({
    baseUrl: urlSchema,
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    testModelId: z.string().min(1).optional(),
  })
  .strict();
const ollamaSettingsSchema = z
  .object({ baseUrl: urlSchema.default('http://127.0.0.1:11434/v1') })
  .strict();
const azureSettingsSchema = z
  .object({
    apiKey: z.string().min(1),
    resourceName: z.string().min(1).optional(),
    baseUrl: urlSchema.optional(),
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
const bedrockSettings = {
  region: z.string().min(1).default('us-east-1'),
  testModelId: z.string().min(1).optional(),
};
const bedrockSettingsSchema = z.discriminatedUnion('authMode', [
  z
    .object({ ...bedrockSettings, authMode: z.literal('default-chain') })
    .strict(),
  z
    .object({
      ...bedrockSettings,
      authMode: z.literal('access-keys'),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...bedrockSettings,
      authMode: z.literal('api-key'),
      apiKey: z.string().min(1),
    })
    .strict(),
]);
const vertexSettings = {
  project: z.string().min(1).optional(),
  location: z.string().min(1).default('us-central1'),
  testModelId: z.string().min(1).optional(),
};
const vertexSettingsSchema = z.discriminatedUnion('authMode', [
  z.object({ ...vertexSettings, authMode: z.literal('adc') }).strict(),
  z
    .object({
      ...vertexSettings,
      authMode: z.literal('service-account'),
      googleCredentials: jsonCredentialSchema,
    })
    .strict(),
  z
    .object({
      ...vertexSettings,
      authMode: z.literal('api-key'),
      apiKey: z.string().min(1),
    })
    .strict(),
]);
const codexSettingsSchema = z
  .object({
    codexExecutable: z.string().min(1).default('codex'),
    authFile: z.string().min(1).optional(),
    baseUrl: urlSchema.optional(),
    testModelId: z.string().min(1).optional().meta({ readOnly: true }),
  })
  .strict();
const providerSettingsSchemas = {
  openai: openAiSettingsSchema,
  anthropic: apiKeySettingsSchema,
  'google-gemini': apiKeySettingsSchema,
  'google-vertex': vertexSettingsSchema,
  'amazon-bedrock': bedrockSettingsSchema,
  'azure-openai': azureSettingsSchema,
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
  'chatgpt-codex-subscription': codexSettingsSchema,
  'chat-completions': endpointSettingsSchema,
  responses: endpointSettingsSchema,
  'anthropic-messages': endpointSettingsSchema,
  'google-generative': endpointSettingsSchema,
  ollama: ollamaSettingsSchema,
} satisfies Record<ProviderType, z.ZodType<Record<string, unknown>>>;
const providerSchema = z
  .object({
    type: providerTypeSchema,
    settings: z.record(z.string(), z.unknown()).default({}),
    knownModels: z.record(z.string().min(1), modelDefinitionSchema).optional(),
  })
  .strict()
  .transform((provider) => ({
    ...provider,
    settings: providerSettingsSchemas[provider.type].parse(provider.settings),
  }));
const voiceSelectionSchema = z
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
    consult: z.array(modelSelectionEntrySchema).default([]),
    voice: voiceSelectionSchema.default({ sts: [], tts: [], stt: [] }),
  })
  .strict();
const versionNegotiationSchema = z.union([
  z.enum(['legacy', 'auto']),
  z.object({ pin: z.string().min(1) }).strict(),
]);
const mcpServerSchema = z.union([
  z
    .object({
      type: z.literal('stdio').optional(),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      versionNegotiation: versionNegotiationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(['http', 'streamable-http']).optional(),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      versionNegotiation: versionNegotiationSchema.optional(),
    })
    .strict(),
]);
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

// The released transformation applies defaults and strips unknown root fields.
export const configV3OutputSchema = z.object({
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
  providers: z.record(providerIdSchema, providerSchema).default({}),
  modelSelection: modelSelectionSchema.default({
    chat: [],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    consult: [],
    voice: { sts: [], tts: [], stt: [] },
  }),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  timezone: timezoneSchema.default('UTC'),
});
// Persisted validation requires configVersion and also accepts telemetry.
export const configV3Schema = configV3OutputSchema
  .extend({ configVersion: z.literal(2), telemetry: z.unknown().optional() })
  .strict();
export type ConfigV3 = z.infer<typeof configV3OutputSchema>;
