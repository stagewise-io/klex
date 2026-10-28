import {
  InvalidArgumentError,
  type LanguageModelV4,
  LoadAPIKeyError,
  LoadSettingError,
  TypeValidationError,
} from '@ai-sdk/provider';
import { APICallError, NoSuchModelError, streamText } from 'ai';
import { z } from 'zod';

import { providerTypeSchema } from '@/config';

export const modelValidationInputSchema = z
  .object({
    provider: z.union([
      z.object({ id: z.string().min(1) }).strict(),
      z
        .object({
          type: providerTypeSchema,
          settings: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ]),
    modelId: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) => value.trim() === value,
        'Must not contain surrounding whitespace',
      ),
    purpose: z
      .enum([
        'chat',
        'compaction',
        'memory',
        'consult',
        'instincts',
        'imageVision',
        'audioListening',
        'voice.sts',
      ])
      .default('chat'),
    providerOptions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict();

export const modelValidationResultSchema = z.object({
  status: z.enum(['valid', 'invalid', 'unverified', 'unsupported']),
  code: z.enum([
    'available',
    'invalid_configuration',
    'provider_not_found',
    'authentication_required',
    'permission_denied',
    'model_not_found',
    'request_rejected',
    'rate_limited',
    'timeout',
    'cancelled',
    'provider_changed',
    'connectivity_failed',
    'unsupported_operation',
  ]),
  message: z.string(),
  remediation: z.string().optional(),
  scope: z.literal('language-generation'),
});

export type ModelValidationInput = z.infer<typeof modelValidationInputSchema>;
export type ModelValidationResult = z.infer<typeof modelValidationResultSchema>;

type Status = ModelValidationResult['status'];
type Code = ModelValidationResult['code'];

export function modelValidationResult(
  status: Status,
  code: Code,
  message: string,
  remediation?: string,
): ModelValidationResult {
  return {
    status,
    code,
    message,
    ...(remediation && { remediation }),
    scope: 'language-generation',
  };
}

/** Small, potentially billable probes. Never supply agent context or write configuration. */
export class ModelValidation {
  private readonly active = new Set<AbortController>();

  close(): void {
    for (const controller of this.active) controller.abort();
  }

  async run(
    createModel: () => LanguageModelV4,
    input: ModelValidationInput,
    signal: AbortSignal | undefined,
    unchanged: () => boolean,
  ): Promise<ModelValidationResult> {
    if (signal?.aborted) return cancelled();
    const options = z
      .record(z.string(), z.record(z.string(), z.json()))
      .safeParse(input.providerOptions ?? {});
    if (!options.success)
      return modelValidationResult(
        'invalid',
        'invalid_configuration',
        'Provider options must contain JSON values.',
      );
    if (this.active.size >= 2)
      return modelValidationResult(
        'unverified',
        'rate_limited',
        'Model validation is busy.',
        'Wait for the current checks to finish, then retry.',
      );
    const controller = new AbortController();
    this.active.add(controller);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    timeout.unref?.();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<ModelValidationResult>((resolve) => {
      onAbort = () =>
        resolve(
          timedOut
            ? modelValidationResult(
                'unverified',
                'timeout',
                'The model check timed out.',
                'Retry when the provider is responding. The model has not been verified.',
              )
            : cancelled(),
        );
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    const operation = Promise.resolve()
      .then(async () => {
        combined.throwIfAborted();
        let model: LanguageModelV4;
        try {
          model = createModel();
        } catch (error) {
          const result = classifyModelValidationError(error);
          return result.code === 'connectivity_failed'
            ? modelValidationResult(
                'invalid',
                'invalid_configuration',
                'The provider could not create the model from these settings.',
                'Check required settings and resolved credentials.',
              )
            : result;
        }
        const generation = new AbortController();
        try {
          const result = streamText({
            model,
            prompt: 'Reply with OK.',
            maxRetries: 0,
            abortSignal: AbortSignal.any([combined, generation.signal]),
            providerOptions: options.data,
            experimental_telemetry: { isEnabled: false },
            // The SDK's default error callback logs raw upstream errors.
            onError: () => {},
          });
          // Stop at the first generated token. A fixed output-token limit can
          // invalidate otherwise valid thinking-budget provider options.
          for await (const part of result.fullStream) {
            if (part.type === 'error')
              return classifyModelValidationError(part.error);
            if (
              part.type === 'finish' &&
              part.finishReason === 'content-filter'
            )
              return modelValidationResult(
                'unverified',
                'request_rejected',
                'The provider filtered the model check.',
                'Check the provider content policy, then retry.',
              );
            if (part.type === 'finish' && part.finishReason === 'error')
              return modelValidationResult(
                'unverified',
                'request_rejected',
                'The provider ended the model check with an error.',
                'Check provider settings and availability, then retry.',
              );
            if (
              part.type === 'text-delta' ||
              part.type === 'reasoning-delta' ||
              (part.type === 'finish' &&
                (part.finishReason === 'stop' ||
                  part.finishReason === 'length' ||
                  part.finishReason === 'tool-calls'))
            )
              return modelValidationResult(
                'valid',
                'available',
                'The model accepted a language-generation request.',
              );
          }
          return modelValidationResult(
            'unverified',
            'connectivity_failed',
            'The provider did not complete the model check.',
            'Retry the check.',
          );
        } finally {
          generation.abort();
        }
      })
      .catch(classifyModelValidationError);
    // Keep the concurrency slot until the provider settles, even if it ignores abort.
    void operation.finally(() => this.active.delete(controller));
    try {
      const result = await Promise.race([operation, aborted]);
      if (combined.aborted)
        return timedOut
          ? modelValidationResult(
              'unverified',
              'timeout',
              'The model check timed out.',
              'Retry the check.',
            )
          : cancelled();
      if (!unchanged())
        return modelValidationResult(
          'unverified',
          'provider_changed',
          'Provider settings changed during the check.',
          'Run the check again with the current settings.',
        );
      return result;
    } finally {
      clearTimeout(timeout);
      if (onAbort) combined.removeEventListener('abort', onAbort);
    }
  }
}

function cancelled(): ModelValidationResult {
  return modelValidationResult(
    'unverified',
    'cancelled',
    'The model check was cancelled.',
    'Retry the check.',
  );
}

export function classifyModelValidationError(
  error: unknown,
): ModelValidationResult {
  // The SDK can wrap upstream failures. Never return raw bodies, messages, or URLs.
  for (let depth = 0; depth < 5; depth++) {
    if (NoSuchModelError.isInstance(error))
      return modelValidationResult(
        'invalid',
        'model_not_found',
        'This model is not supported by the provider.',
        'Check the model ID or Azure deployment name.',
      );
    if (
      InvalidArgumentError.isInstance(error) ||
      LoadAPIKeyError.isInstance(error) ||
      LoadSettingError.isInstance(error) ||
      TypeValidationError.isInstance(error)
    )
      return modelValidationResult(
        'invalid',
        'invalid_configuration',
        'The provider settings or model options are invalid.',
        'Check required settings and provider options.',
      );
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      if (status === 401)
        return modelValidationResult(
          'invalid',
          'authentication_required',
          'The provider rejected authentication.',
          'Check the provider credentials or sign in again.',
        );
      if (status === 403)
        return modelValidationResult(
          'invalid',
          'permission_denied',
          'The provider denied access to this model.',
          'Check model access, deployment permissions, and region.',
        );
      if (status === 404)
        return modelValidationResult(
          'invalid',
          'model_not_found',
          'The model, deployment, or API endpoint was not found.',
          'Check the exact model ID, Azure deployment name, endpoint, and API version.',
        );
      if (status === 400 || status === 422)
        return modelValidationResult(
          'invalid',
          'request_rejected',
          'The provider rejected the model request.',
          'Check the model ID, API version, and provider options.',
        );
      if (status === 429)
        return modelValidationResult(
          'unverified',
          'rate_limited',
          'The provider rejected the check because of a rate or quota limit.',
          'Check provider quota or billing, then retry.',
        );
      return modelValidationResult(
        'unverified',
        'connectivity_failed',
        'The provider could not complete the model check.',
        'Check provider availability and network access, then retry.',
      );
    }
    if (!(error instanceof Error) || error.cause === undefined) break;
    error = error.cause;
  }
  return modelValidationResult(
    'unverified',
    'connectivity_failed',
    'The model check could not be completed.',
    'Check provider settings and connectivity, then retry.',
  );
}
