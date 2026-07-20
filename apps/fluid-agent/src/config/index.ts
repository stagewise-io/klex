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

// MCP server config (standard mcp.json shape)

const stdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

type StdioServerConfig = z.infer<typeof stdioServerConfigSchema>;

const httpServerConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

type HttpServerConfig = z.infer<typeof httpServerConfigSchema>;

const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  httpServerConfigSchema,
]);

type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export const fluidConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema),
  modelSelection: modelSelectionSchema,
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});

type FluidConfig = z.infer<typeof fluidConfigSchema>;

export const modelProviderConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema),
  modelSelection: modelSelectionSchema,
});

export type ModelProviderConfig = z.infer<typeof modelProviderConfigSchema>;

export type {
  ApiFormat,
  EndpointAuth,
  EndpointConfig,
  FluidConfig,
  HttpServerConfig,
  McpServerConfig,
  ModelEntry,
  ModelId,
  ModelSelection,
  ProviderConfig,
  StdioServerConfig,
};
