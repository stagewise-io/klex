import { z } from 'zod';

const providerIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    'Must not contain surrounding whitespace',
  );
export const apiFormatV1Schema = z.enum([
  'openai',
  'anthropic',
  'google',
  'chat-completions',
  'open-responses',
  'messages',
  'realtime',
  'speech',
  'transcriptions',
]);
export type ApiFormatV1 = z.infer<typeof apiFormatV1Schema>;
const endpointAuthSchema = z.object({
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type EndpointAuthV1 = z.infer<typeof endpointAuthSchema>;
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
const endpointSchema = z.object({
  url: z.url(),
  format: apiFormatV1Schema,
  auth: endpointAuthSchema,
  knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
});
const providerSchema = z.union([
  z
    .object({
      preset: z.enum(['openai', 'anthropic', 'google']),
      auth: endpointAuthSchema,
      knownModels: z.record(z.string(), modelDefinitionSchema).optional(),
    })
    .strict(),
  z.object({ endpoints: z.record(z.string(), endpointSchema) }).strict(),
]);
export type ProviderV1 = z.infer<typeof providerSchema>;
const modelSelectionEntrySchema = z.union([
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
export type ModelSelectionEntryV1 = z.infer<typeof modelSelectionEntrySchema>;
const modelSelectionSchema = z
  .object({
    chat: z.array(modelSelectionEntrySchema).default([]),
    compaction: z.array(modelSelectionEntrySchema).default([]),
    memory: z.array(modelSelectionEntrySchema).default([]),
    imageVision: z.array(modelSelectionEntrySchema).default([]),
    audioListening: z.array(modelSelectionEntrySchema).default([]),
    consult: z.array(modelSelectionEntrySchema).default([]),
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
export const configV1Schema = z
  .object({
    episodeFinishIdleTriggerTimeMs: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(300_000),
    officialName: z.string().trim().min(2).default('Agent'),
    providers: z.record(providerIdSchema, providerSchema).default({}),
    modelSelection: modelSelectionSchema,
    mcpServers: z.record(z.string(), mcpServerSchema).default({}),
    telemetry: z.unknown().optional(),
  })
  .strict();
