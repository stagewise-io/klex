import type { LanguageModelV4 } from '@ai-sdk/provider';
import { APICallError, streamText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderInstance } from '../provider-registry';
import {
  gatewayAttributionHeaders,
  sanitizedError,
  testModelConnection,
} from './shared';

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn(),
}));

const instance = (settings: Record<string, unknown>): ProviderInstance => ({
  id: 'codex',
  type: 'chatgpt-codex-subscription',
  settings,
});

describe('gatewayAttributionHeaders', () => {
  it('identifies gateway traffic as Klex', () => {
    expect(gatewayAttributionHeaders()).toEqual({
      'HTTP-Referer': 'https://klex.bot',
      'X-Title': 'Klex',
    });
  });
});

describe('testModelConnection', () => {
  it('uses the provider default when no test model is configured', async () => {
    vi.mocked(streamText).mockReturnValue({
      text: Promise.resolve('OK'),
    } as never);
    const createModel = vi.fn(() => ({}) as LanguageModelV4);

    const result = await testModelConnection(
      instance({}),
      'https://example.test/responses',
      createModel,
      new AbortController().signal,
      'gpt-5-codex',
    );

    expect(result.ok).toBe(true);
    expect(createModel).toHaveBeenCalledWith('gpt-5-codex');
  });

  it('prefers the configured test model', async () => {
    vi.mocked(streamText).mockReturnValue({
      text: Promise.resolve('OK'),
    } as never);
    const createModel = vi.fn(() => ({}) as LanguageModelV4);

    await testModelConnection(
      instance({ testModelId: 'gpt-custom-codex' }),
      'https://example.test/responses',
      createModel,
      new AbortController().signal,
      'gpt-5-codex',
    );

    expect(createModel).toHaveBeenCalledWith('gpt-custom-codex');
  });

  it('surfaces the underlying stream error', async () => {
    const apiError = new APICallError({
      message: 'Bad request',
      url: 'https://example.test/responses',
      requestBodyValues: {},
      statusCode: 400,
    });
    vi.mocked(streamText).mockImplementation((options) => {
      options.onError?.({ error: apiError });
      return {
        text: Promise.reject(new Error('No output generated')),
      } as never;
    });

    const result = await testModelConnection(
      instance({ testModelId: 'gpt-test' }),
      'https://example.test/responses',
      () => ({}) as LanguageModelV4,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'connectivity_failed',
      message: 'Provider returned HTTP 400',
    });
  });

  it('preserves safe HTTP status diagnostics', () => {
    expect(
      sanitizedError(
        new APICallError({
          message: 'Unauthorized',
          url: 'https://example.test/responses',
          requestBodyValues: {},
          statusCode: 401,
        }),
      ),
    ).toBe('Provider returned HTTP 401');
  });
});
