import { experimental_evaluate as evaluate } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderInstance } from '../provider-registry';
import { vercelAiGatewayProviderDefinition as provider } from './vercel-ai-gateway';

const instance: ProviderInstance = {
  id: 'gateway',
  type: 'vercel-ai-gateway',
  settings: {
    apiKey: 'synthetic-key',
    baseUrl: 'https://synthetic.invalid/v4/ai/',
    teamIdOrSlug: 'team_test',
    headers: { 'x-test': 'synthetic' },
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('Vercel AI Gateway', () => {
  it('constructs language models and keeps Jev evaluation-only', () => {
    expect(
      provider.createLanguageModel!(instance, 'openai/gpt-4.1'),
    ).toMatchObject({
      specificationVersion: 'v4',
      provider: 'gateway',
      modelId: 'openai/gpt-4.1',
    });
    expect(provider.resolveModelMetadata!('typesafe-ai/jev')).toMatchObject({
      kind: 'evaluation',
    });
    expect(() =>
      provider.createLanguageModel!(instance, 'typesafe-ai/jev'),
    ).toThrow('Evaluation-only');
    expect(() =>
      provider.createEvaluationModel!(
        { ...instance, settings: {} },
        'typesafe-ai/jev',
      ),
    ).toThrow('apiKey');
  });

  it('discovers native evaluation models without mislabeling them as chat models', async () => {
    const model = (id: string, modelType?: string) => ({
      id,
      name: id,
      modelType,
      specification: {
        specificationVersion: 'v4',
        provider: 'gateway',
        modelId: id,
      },
    });
    const fetch = vi.fn(async () =>
      json({
        models: [
          model('typesafe-ai/jev'),
          model('openai/gpt-4.1', 'language'),
          model('legacy/language'),
          model('embed/model', 'embedding'),
          model('future/model', 'unknown'),
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = await provider.discoverModels!(instance, signal);
    expect(result).toMatchObject({
      ok: true,
      value: [
        { modelId: 'typesafe-ai/jev', kind: 'evaluation' },
        { modelId: 'openai/gpt-4.1', kind: 'language' },
        { modelId: 'legacy/language', kind: 'language' },
      ],
    });
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://synthetic.invalid/v4/ai/config');
    expect(options.signal).toBe(signal);
  });

  it('sends Jev boolean and choice evaluation through the native Gateway transport', async () => {
    const fetch = vi.fn(async () =>
      json({
        answers: {
          flag: { type: 'boolean', probability: 0.8 },
          mood: {
            type: 'choice',
            choice: 'calm',
            probabilities: { calm: 0.9, angry: 0.1 },
          },
        },
        usage: { inputTokens: 12, outputTokens: 3 },
        model: 'typesafe-ai/jev',
        providerMetadata: {
          gateway: { routing: { finalProvider: 'typesafe-ai' } },
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const questions = {
      flag: { type: 'boolean' as const, instructions: 'Flag?' },
      mood: {
        type: 'choice' as const,
        instructions: 'Mood?',
        criteria: { calm: 'Calm', angry: 'Angry' },
      },
    };
    const result = await evaluate({
      model: provider.createEvaluationModel!(instance, 'typesafe-ai/jev'),
      state: 'synthetic',
      questions,
      abortSignal: signal,
      maxRetries: 0,
      providerOptions: { gateway: { order: ['typesafe-ai'] } },
    });
    expect(result.answers.flag).toEqual({ type: 'boolean', probability: 0.8 });
    expect(result.answers.mood).toMatchObject({
      type: 'choice',
      choice: 'calm',
    });
    expect(result.usage.totalTokens).toBe(15);
    expect(result.providerMetadata?.gateway).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://synthetic.invalid/v4/ai/evaluation-model');
    const headers = new Headers(options.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-key');
    expect(headers.get('ai-model-id')).toBe('typesafe-ai/jev');
    expect(headers.get('ai-evaluation-model-specification-version')).toBe('4');
    expect(headers.get('x-test')).toBe('synthetic');
    expect(headers.get('x-vercel-ai-gateway-team')).toBe('team_test');
    expect(options.signal).toBe(signal);
    expect(JSON.parse(options.body as string)).toEqual({
      state: 'synthetic',
      questions,
      providerOptions: { gateway: { order: ['typesafe-ai'] } },
    });
  });

  it('tests authenticated credits without inference', async () => {
    const fetch = vi.fn(async () => json({ balance: '10', total_used: '2' }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await provider.testConnection!(instance, new AbortController().signal),
    ).toMatchObject({
      ok: true,
      value: { target: 'https://synthetic.invalid' },
    });
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://synthetic.invalid/v1/credits?teamId=team_test');
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer synthetic-key',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to SDK metadata requests and sanitizes errors', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('synthetic-key private error')),
          { once: true },
        );
        controller.abort();
      });
    });
    vi.stubGlobal('fetch', fetch);
    expect(
      await provider.discoverModels!(instance, controller.signal),
    ).toMatchObject({
      ok: false,
      code: 'discovery_failed',
      message: 'Provider request failed',
    });
  });
});
