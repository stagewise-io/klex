import z from 'zod';

// ModelId: providerId:endpointId:modelId

const modelIdSchema = z.custom<`${string}:${string}:${string}`>(
  (v): v is `${string}:${string}:${string}` =>
    typeof v === 'string' && /^[^:]+:[^:]+:[^:]+$/.test(v),
);

type ModelId = z.infer<typeof modelIdSchema>;

// ApiFormat: which wire protocol / AI-SDK provider

const apiFormatSchema = z.enum([
  'openai-chat-completions',
  'openai-responses',
  'anthropic',
  'google',
]);

type ApiFormat = z.infer<typeof apiFormatSchema>;

// Endpoint auth

const endpointAuthSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
});

type EndpointAuth = z.infer<typeof endpointAuthSchema>;

// Model entry: metadata for a model served at an endpoint

const modelEntrySchema = z.object({
  displayName: z.string().optional(),
});

type ModelEntry = z.infer<typeof modelEntrySchema>;

// Endpoint config

const endpointConfigSchema = z.object({
  url: z.string().url(),
  format: apiFormatSchema,
  auth: endpointAuthSchema,
  models: z.record(z.string(), modelEntrySchema).optional(),
});

type EndpointConfig = z.infer<typeof endpointConfigSchema>;

// Provider config: a named provider with one or more endpoints

const providerConfigSchema = z.object({
  endpoints: z.record(z.string(), endpointConfigSchema),
});

type ProviderConfig = z.infer<typeof providerConfigSchema>;

// Model selection: which models to use for each purpose

const modelSelectionSchema = z.object({
  chat: z.array(modelIdSchema),
  compression: z.array(modelIdSchema),
  memory: z.array(modelIdSchema),
});

type ModelSelection = z.infer<typeof modelSelectionSchema>;

// Full model provider config

export const modelProviderConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema),
  modelSelection: modelSelectionSchema,
});

export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

export type {
  ApiFormat,
  EndpointAuth,
  EndpointConfig,
  ModelEntry,
  ModelId,
  ModelSelection,
  ProviderConfig,
};
