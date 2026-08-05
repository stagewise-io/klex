import z from 'zod';

// ModelId: providerId:modelId (preset) or providerId:endpointId:modelId (manual)

const modelIdSchema = z.custom<`${string}:${string}`>(
  (value): value is `${string}:${string}` =>
    typeof value === 'string' && /^[^:]+:.+$/.test(value),
  {
    error:
      'Model ID must use the format providerId:modelId (preset) or providerId:endpointId:modelId (manual) with non-empty segments',
  },
);

type ModelId = z.infer<typeof modelIdSchema>;

// Model selection entry: bare ModelId (back-compat) or object with optional providerOptions

interface ModelSelectionEntryObject {
  model: ModelId;
  providerOptions?: Record<string, Record<string, unknown>>;
}

type ModelSelectionEntry = ModelId | ModelSelectionEntryObject;

const modelSelectionEntrySchema = z.union([
  modelIdSchema,
  z
    .object({
      model: modelIdSchema,
      providerOptions: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional(),
    })
    .strict(),
]);

/**
 * Extracts the bare ModelId from a ModelSelectionEntry (string or object).
 */
function modelIdFromEntry(entry: ModelSelectionEntry): ModelId {
  return typeof entry === 'string' ? entry : entry.model;
}

// ApiFormat: which wire protocol / AI-SDK provider

const apiFormatSchema = z.enum([
  // Direct vendor providers
  'openai', // used for full OpenAI API
  'anthropic', // used for full Anthropic API
  'google', // used for full Google API

  // Standardized formats for individual functionalities
  'chat-completions', // used for OpenAI-compatible chat completions endpoints
  'open-responses', // used for OpenAI-compatible responses endpoints
  'messages', // used for Anthropic-compatible messages endpoints
]);

type ApiFormat = z.infer<typeof apiFormatSchema>;

// Endpoint auth: apiKey (literal or {env:VAR}) plus optional custom headers

const endpointAuthSchema = z.object({
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type EndpointAuth = z.infer<typeof endpointAuthSchema>;

// Endpoint config

const endpointConfigSchema = z.object({
  url: z.url(),
  format: apiFormatSchema,
  auth: endpointAuthSchema,
});

type EndpointConfig = z.infer<typeof endpointConfigSchema>;

// Provider preset: a named bundle of endpoint URL and format

const providerPresetSchema = z.enum(['openai', 'anthropic', 'google']);

type ProviderPreset = z.infer<typeof providerPresetSchema>;

interface PresetDefinition {
  url: string;
  format: ApiFormat;
}

const providerPresets: Record<ProviderPreset, PresetDefinition> = {
  openai: {
    url: 'https://api.openai.com/v1',
    format: 'openai',
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1',
    format: 'anthropic',
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    format: 'google',
  },
};

export function resolvePresetEndpoint(
  preset: ProviderPreset,
  auth: EndpointAuth,
): EndpointConfig {
  const def = providerPresets[preset];
  return {
    url: def.url,
    format: def.format,
    auth,
  };
}

// Model definition: optional per-model metadata inside a provider

const imageInputCapabilitySchema = z
  .object({
    mediaTypes: z
      .array(z.string().regex(/^image\/[a-z0-9][a-z0-9.+-]*$/i))
      .nonempty(),
    maxBytes: z.number().int().positive(),
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
      .nonempty(),
    maxBytes: z.number().int().positive(),
  })
  .strict();

const modelInputCapabilitiesSchema = z
  .object({
    image: imageInputCapabilitySchema.optional(),
    audio: audioInputCapabilitySchema.optional(),
  })
  .strict();

const modelDefinitionSchema = z
  .object({
    displayName: z.string().optional(),
    contextSize: z.number().int().positive().optional(),
    inputCapabilities: modelInputCapabilitiesSchema.optional(),
  })
  .strict();

type ModelInputCapabilities = z.infer<typeof modelInputCapabilitiesSchema>;
type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

// Manual endpoint: endpoint config with optional known model metadata
const manualEndpointSchema = endpointConfigSchema.extend({
  knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
});

type ManualEndpoint = z.infer<typeof manualEndpointSchema>;

// Provider config: a named provider with either a preset or manual endpoints

const presetProviderSchema = z
  .object({
    preset: providerPresetSchema,
    auth: endpointAuthSchema,
    knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
  })
  .strict();

const manualProviderSchema = z
  .object({
    endpoints: z.record(z.string(), manualEndpointSchema),
  })
  .strict();

const providerConfigSchema = z.union([
  presetProviderSchema,
  manualProviderSchema,
]);

type ProviderConfig = z.infer<typeof providerConfigSchema>;

// Model selection: which models to use for each purpose

const modelSelectionSchema = z.object({
  chat: z.array(modelSelectionEntrySchema),
  compaction: z.array(modelSelectionEntrySchema),
  memory: z.array(modelSelectionEntrySchema),
  routing: z.array(modelSelectionEntrySchema),
});

type ModelSelection = z.infer<typeof modelSelectionSchema>;
type ModelPurpose = keyof ModelSelection;

// MCP server config (standard mcp.json shape)

const mcpVersionNegotiationSchema = z.union([
  z.enum(['legacy', 'auto']),
  z.object({ pin: z.string().min(1) }).strict(),
]);

type McpVersionNegotiation = z.infer<typeof mcpVersionNegotiationSchema>;

const stdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  versionNegotiation: mcpVersionNegotiationSchema.optional(),
});

type StdioServerConfig = z.infer<typeof stdioServerConfigSchema>;

const httpServerConfigSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  versionNegotiation: mcpVersionNegotiationSchema.optional(),
});

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
  providers: z.record(z.string(), providerConfigSchema),
  modelSelection: modelSelectionSchema,
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
  telemetry: telemetryConfigSchema.optional(),
});

type KlexConfig = z.infer<typeof klexConfigSchema>;

export type {
  ApiFormat,
  EndpointAuth,
  EndpointConfig,
  HttpServerConfig,
  KlexConfig,
  ManualEndpoint,
  McpServerConfig,
  McpVersionNegotiation,
  ModelDefinition,
  ModelId,
  ModelInputCapabilities,
  ModelPurpose,
  ModelSelection,
  ModelSelectionEntry,
  ProviderConfig,
  ProviderPreset,
  StdioServerConfig,
  TelemetryLevel,
};
export {
  klexConfigSchema,
  mcpServerConfigSchema,
  modelIdFromEntry,
  modelIdSchema,
  modelSelectionSchema,
  telemetryLevelSchema,
};
