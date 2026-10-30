import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ModelValidation,
  type ModelValidationInput,
  modelValidationInputSchema,
} from './model-validation';

const input: ModelValidationInput = {
  provider: { id: 'openai' },
  modelId: 'exact-deployment',
  purpose: 'chat',
  providerOptions: { openai: { reasoningEffort: 'low' } },
};
function respondingModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'test' });
          controller.enqueue({ type: 'text-delta', id: 'test', delta: 'OK' });
          controller.close();
        },
      }),
    }),
  });
}
afterEach(() => vi.useRealTimers());

describe('model validation probe', () => {
  it.each([
    [
      'anthropic',
      { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    ],
    ['anthropic', { anthropic: { cacheControl: null } }],
    [
      'anthropic-messages',
      { anthropic: { cacheControl: { type: 'ephemeral' } } },
    ],
    ['anthropic-messages', { anthropic: { cacheControl: null } }],
    ['vercel-ai-gateway', { gateway: { caching: 'auto' } }],
    ['vercel-ai-gateway', { gateway: { caching: null } }],
    ['openrouter', { openrouter: { cache_control: { type: 'ephemeral' } } }],
    ['openrouter', { openrouter: { cache_control: null } }],
  ])(
    'accepts and forwards %s caching options: %j',
    async (type, providerOptions) => {
      const parsed = modelValidationInputSchema.parse({
        ...input,
        provider: { type, settings: {} },
        providerOptions,
      });
      const model = respondingModel();
      expect(
        await new ModelValidation().run(
          () => model,
          parsed,
          undefined,
          () => true,
        ),
      ).toMatchObject({ status: 'valid' });
      expect(model.doStreamCalls[0]?.providerOptions).toEqual(providerOptions);
    },
  );

  it.each([
    ['voice.tts', false],
    ['voice.stt', false],
    ['voice.sts', true],
    ['audioListening', true],
  ])('validates selection purpose %s as %s', (purpose, accepted) => {
    expect(
      modelValidationInputSchema.safeParse({ ...input, purpose }).success,
    ).toBe(accepted);
  });

  it('generates with exact options and ignores stale successes', async () => {
    const model = respondingModel();
    const validation = new ModelValidation();
    expect(
      await validation.run(
        () => model,
        input,
        undefined,
        () => true,
      ),
    ).toMatchObject({ status: 'valid', scope: 'language-generation' });
    expect(model.doStreamCalls[0]).toMatchObject({
      providerOptions: input.providerOptions,
    });
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBeUndefined();
    expect(
      await validation.run(respondingModel, input, undefined, () => false),
    ).toMatchObject({ status: 'unverified', code: 'provider_changed' });
  });

  it('classifies local model factory failures without exposing settings', async () => {
    const result = await new ModelValidation().run(
      () => {
        throw new Error('Provider secret-provider requires secret-setting');
      },
      input,
      undefined,
      () => true,
    );
    expect(result).toMatchObject({
      status: 'invalid',
      code: 'invalid_configuration',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    ['stop', 'valid', 'available'],
    ['length', 'valid', 'available'],
    ['tool-calls', 'valid', 'available'],
    ['other', 'unverified', 'connectivity_failed'],
    ['content-filter', 'unverified', 'request_rejected'],
    ['error', 'unverified', 'request_rejected'],
    ['interrupted', 'unverified', 'connectivity_failed'],
  ] as const)(
    'classifies a %s finish without generated tokens',
    async (finishReason, status, code) => {
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              // Simulate a stream interrupted before the provider's finish signal.
              if (finishReason !== 'interrupted')
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: finishReason, raw: finishReason },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 0, text: 0, reasoning: 0 },
                  },
                });
              controller.close();
            },
          }),
        }),
      });
      const result = await new ModelValidation().run(
        () => model,
        input,
        undefined,
        () => true,
      );
      expect(result).toMatchObject({ status, code });
      if (finishReason === 'content-filter')
        expect(result.message).toContain('filtered');
      if (finishReason === 'error') expect(result.message).toContain('error');
    },
  );

  it.each([
    [401, 'invalid', 'authentication_required'],
    [403, 'invalid', 'permission_denied'],
    [404, 'invalid', 'model_not_found'],
    [400, 'invalid', 'request_rejected'],
    [429, 'unverified', 'rate_limited'],
    [500, 'unverified', 'connectivity_failed'],
  ])(
    'classifies HTTP %s without exposing upstream secrets',
    async (statusCode, status, code) => {
      const model = new MockLanguageModelV4({
        doStream: async () => {
          throw new APICallError({
            message: 'secret-key',
            url: 'https://secret-endpoint',
            requestBodyValues: { key: 'secret-key' },
            statusCode,
            responseBody: 'secret-key',
          });
        },
      });
      const result = await new ModelValidation().run(
        () => model,
        input,
        undefined,
        () => true,
      );
      expect(result).toMatchObject({ status, code });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(model.doStreamCalls).toHaveLength(1);
    },
  );

  it('bounds concurrency and returns on timeout or cancellation even if a provider hangs', async () => {
    vi.useFakeTimers();
    const validation = new ModelValidation();
    const model = new MockLanguageModelV4({
      doStream: () => new Promise(() => {}),
    });
    const signal = new AbortController();
    const first = validation.run(
      () => model,
      input,
      signal.signal,
      () => true,
    );
    const second = validation.run(
      () => model,
      input,
      undefined,
      () => true,
    );
    expect(
      await validation.run(
        () => model,
        input,
        undefined,
        () => true,
      ),
    ).toMatchObject({ code: 'rate_limited' });
    signal.abort();
    expect(await first).toMatchObject({
      status: 'unverified',
      code: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await second).toMatchObject({
      status: 'unverified',
      code: 'timeout',
    });
    validation.close();
  });
});
