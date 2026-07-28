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

// Provider config: a named provider with either a preset or manual endpoints

const presetProviderSchema = z
  .object({
    preset: providerPresetSchema,
    auth: endpointAuthSchema,
  })
  .strict();

const manualProviderSchema = z
  .object({
    endpoints: z.record(z.string(), endpointConfigSchema),
  })
  .strict();

const providerConfigSchema = z.union([
  presetProviderSchema,
  manualProviderSchema,
]);

type ProviderConfig = z.infer<typeof providerConfigSchema>;

// Model selection: which models to use for each purpose

const modelSelectionSchema = z.object({
  chat: z.array(modelIdSchema),
  compression: z.array(modelIdSchema),
  memory: z.array(modelIdSchema),
});

type ModelSelection = z.infer<typeof modelSelectionSchema>;
type ModelPurpose = keyof ModelSelection;

// MCP server config (standard mcp.json shape)

const stdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

type StdioServerConfig = z.infer<typeof stdioServerConfigSchema>;

const httpServerConfigSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

type HttpServerConfig = z.infer<typeof httpServerConfigSchema>;

const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  httpServerConfigSchema,
]);

type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const fluidConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema),
  modelSelection: modelSelectionSchema,
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});

type FluidConfig = z.infer<typeof fluidConfigSchema>;

export type {
  ApiFormat,
  EndpointAuth,
  EndpointConfig,
  FluidConfig,
  HttpServerConfig,
  McpServerConfig,
  ModelId,
  ModelPurpose,
  ModelSelection,
  ProviderConfig,
  ProviderPreset,
  StdioServerConfig,
};
export { mcpServerConfigSchema, modelSelectionSchema };
