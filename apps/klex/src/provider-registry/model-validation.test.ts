import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelValidation, type ModelValidationInput } from './model-validation';

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
