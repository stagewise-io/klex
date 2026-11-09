import { experimental_evaluate as evaluate } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderInstance } from '../provider-registry';
import { openRouterProviderDefinition as provider } from './openrouter';

const instance: ProviderInstance = {
  id: 'router',
  type: 'openrouter',
  settings: { apiKey: 'synthetic', headers: { 'x-test': 'custom' } },
};
const signal = () => new AbortController().signal;
const models = ['perplexity/pplx-decider-v1.2', 'morph/reflex'] as const;
const {
  discoverModels,
  resolveModelMetadata,
  createLanguageModel,
  createEvaluationModel,
} = provider;
if (
  !discoverModels ||
  !resolveModelMetadata ||
  !createLanguageModel ||
  !createEvaluationModel
) {
  throw new Error('OpenRouter provider is missing required model operations');
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter decision models', () => {
  it('discovers the separate decisions catalog and deduplicates models', async () => {
    const decisionModels = [...models, 'future/decision'].map((id) => ({
      id,
      name: id,
      context_length: 65_536,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['decisions'],
      },
      supported_parameters: [],
      endpoints: ['/api/alpha/decisions'],
    }));
    const fetchMock = vi.fn(async (url: URL) =>
      Response.json({
        data: url.searchParams.has('output_modalities')
          ? [
              ...decisionModels,
              {
                id: 'cloudflare/clairic',
                architecture: { output_modalities: ['decisions'] },
                endpoints: ['/api/alpha/extractions'],
              },
            ]
          : [
              {
                id: 'vendor/chat',
                architecture: { output_modalities: ['text'] },
              },
              decisionModels[0],
            ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const abortSignal = signal();
    const result = await discoverModels(instance, abortSignal);
    expect(result).toMatchObject({
      ok: true,
      value: [
        { modelId: 'vendor/chat', kind: 'language' },
        ...decisionModels.map(({ id }) => ({
          modelId: id,
          kind: 'evaluation',
          contextSize: 65_536,
          capabilities: { input: { image: {} } },
        })),
      ],
    });
    expect(result.ok && result.value).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const options = (call as unknown as [URL, RequestInit])[1];
      expect(options.signal).toBe(abortSignal);
      expect(options.headers).toMatchObject({
        Authorization: 'Bearer synthetic',
        'X-Title': 'Klex',
      });
    }
  });

  it.each([false, true])(
    'preserves discovery when the decisions catalog fails: %s',
    async (failDecisions) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: URL) => {
          const decisions = url.searchParams.has('output_modalities');
          return decisions === failDecisions
            ? new Response('unavailable', { status: 503 })
            : Response.json({
                data: [
                  {
                    id: decisions ? 'future/decision' : 'vendor/chat',
                    architecture: {
                      output_modalities: [decisions ? 'decisions' : 'text'],
                    },
                  },
                ],
              });
        }),
      );
      expect(await discoverModels(instance, signal())).toMatchObject({
        ok: true,
        partial: true,
        value: [
          {
            modelId: failDecisions ? 'vendor/chat' : 'future/decision',
            kind: failDecisions ? 'language' : 'evaluation',
          },
        ],
      });
    },
  );

  it.each([401, 429, 503])(
    'preserves HTTP %s when both catalogs fail',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status })),
      );
      expect(await discoverModels(instance, signal())).toMatchObject({
        ok: false,
        code: 'discovery_failed',
        message: `Provider returned HTTP ${status}`,
      });
    },
  );

  it('treats malformed catalogs as failures rather than complete empty lists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: null })),
    );
    expect(await discoverModels(instance, signal())).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it('does not publish a partial catalog after cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.searchParams.has('output_modalities')) {
          controller.abort();
          throw controller.signal.reason;
        }
        return Response.json({ data: [{ id: 'vendor/chat' }] });
      }),
    );
    expect(await discoverModels(instance, controller.signal)).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it.each(models)('keeps %s evaluation-only before discovery', (modelId) => {
    expect(resolveModelMetadata(modelId)).toMatchObject({
      kind: 'evaluation',
    });
    expect(() => createLanguageModel(instance, modelId)).toThrow(
      'Evaluation-only',
    );
  });

  it.each(models)(
    'evaluates boolean, choice and score questions with %s',
    async (modelId) => {
      const fetchMock = vi.fn(async () =>
        Response.json({
          id: 'synthetic-response',
          model: modelId,
          provider: 'Synthetic',
          answers: {
            flag: { type: 'noul', noul: 0.8 },
            route: {
              type: 'choice',
              choice: 'a',
              probabilities: { a: 0.9, b: 0.1 },
              confidence: 0.7,
            },
            urgency: {
              type: 'score',
              score: 0.75,
              probabilities: { '0': 0.25, '1': 0.75 },
            },
          },
          usage: { input_tokens: 20, output_tokens: 3, cost: 0.001 },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const abortSignal = signal();
      const result = await evaluate({
        model: createEvaluationModel(instance, modelId),
        state: { ticket: 'Synthetic ticket' },
        questions: {
          flag: {
            type: 'boolean',
            instructions: 'Flag?',
            criteria: { true: 'yes', false: 'no' },
          },
          route: {
            type: 'choice',
            instructions: 'Route?',
            criteria: { a: 'A', b: 'B' },
          },
          urgency: {
            type: 'score',
            instructions: 'Urgency?',
            criteria: ['low', 'high'],
          },
        },
        providerOptions: {
          openrouter: {
            provider: { order: ['Synthetic'] },
            model: 'must-not-override',
          },
        },
        abortSignal,
        maxRetries: 0,
      });
      expect(result.answers.flag).toEqual({
        type: 'boolean',
        probability: 0.8,
      });
      expect(result.answers.route).toMatchObject({
        type: 'choice',
        choice: 'a',
      });
      expect(result.answers.urgency).toMatchObject({
        type: 'score',
        score: 0.75,
      });
      expect(result.usage.totalTokens).toBe(23);
      expect(result.providerMetadata?.openrouter).toMatchObject({
        cost: 0.001,
        confidence: { route: 0.7 },
      });
      const [url, options] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      expect(options.signal).toBe(abortSignal);
      expect(new Headers(options.headers).get('authorization')).toBe(
        'Bearer synthetic',
      );
      expect(new Headers(options.headers).get('x-title')).toBe('Klex');
      expect(new Headers(options.headers).get('x-test')).toBe('custom');
      expect(JSON.parse(options.body as string)).toMatchObject({
        model: modelId,
        state: { ticket: 'Synthetic ticket' },
        questions: {
          flag: { type: 'noul', criteria: { true: 'yes', false: 'no' } },
        },
        provider: { order: ['Synthetic'] },
      });
    },
  );

  it('uses a configured proxy prefix and propagates HTTP errors', async () => {
    const fetchMock = vi.fn(
      async () => new Response('private upstream error', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createEvaluationModel(
        {
          ...instance,
          settings: {
            ...instance.settings,
            baseUrl: 'https://synthetic.invalid/proxy/api/v1/',
          },
        },
        models[0],
      ).doEvaluate({
        state: 'test',
        questions: { flag: { type: 'boolean', instructions: 'Flag?' } },
      }),
    ).rejects.toMatchObject({ statusCode: 429, isRetryable: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://synthetic.invalid/proxy/api/alpha/decisions',
    );
  });

  it.each([
    { flag: { type: 'refusal', reason: 'No answer' } },
    { flag: { type: 'noul', noul: 1.5 } },
  ])(
    'rejects unsupported or invalid answers instead of inventing decisions',
    async (answers) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            model: models[0],
            answers,
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        ),
      );
      await expect(
        evaluate({
          model: createEvaluationModel(instance, models[0]),
          state: 'test',
          questions: { flag: { type: 'boolean', instructions: 'Flag?' } },
          maxRetries: 0,
        }),
      ).rejects.toThrow();
    },
  );
});
