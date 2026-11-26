import { z } from 'zod';

// CLOUD-244 wire contract. Keep this file identical in Klex and Cloud.
export const soulFailureMessages = {
  auth: 'Provider authentication failed. Check credentials and permissions in model/provider settings.',
  quota:
    'Provider quota is exhausted. Check billing and quota in model/provider settings.',
  rate_limit:
    'Provider rate limit reached. Wait and retry, or choose another chat model.',
  connectivity:
    'Provider connection failed or timed out. Check connectivity and retry.',
  configuration:
    'Chat model configuration is unavailable or unsupported. Check model/provider settings.',
  request_rejected:
    'Provider rejected the request. Check model support and request limits.',
  server_error:
    'Provider server failed. Retry later or choose another provider.',
  unknown: 'Soul generation failed. Retry or check model/provider settings.',
  invalid_output:
    'The model returned an empty, incomplete, or invalid soul. Retry or choose another chat model.',
} as const;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_./:-]+$/)
  .refine((value) => !/sk-|AIza|bearer|:\/\/|www\./i.test(value))
  .nullable();
export const soulFailureSchema = z
  .object({
    kind: z.literal('soul_generation_failed'),
    category: z.enum([
      'auth',
      'quota',
      'rate_limit',
      'connectivity',
      'configuration',
      'request_rejected',
      'server_error',
      'unknown',
      'invalid_output',
    ]),
    reason: z.enum([
      'provider_error',
      'no_chat_models',
      'empty_output',
      'length',
      'rejected_format',
    ]),
    providerId: identifier,
    providerType: identifier,
    modelId: identifier,
    statusCode: z.number().int().min(100).max(599).nullable(),
    message: z.enum(Object.values(soulFailureMessages)),
  })
  .refine((value) => value.message === soulFailureMessages[value.category]);

export type SoulFailure = z.infer<typeof soulFailureSchema>;
export const soulStatusSchema = z.object({
  failure: soulFailureSchema.nullable(),
});
