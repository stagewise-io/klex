import { experimental_evaluate as evaluate } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderType } from '@/config';

import { builtInProviderDefinitions } from './providers';

function provider(type: ProviderType) {
  const definition = builtInProviderDefinitions.find(
    (candidate) => candidate.type === type,
  );
  if (!definition) throw new Error(`Missing provider '${type}'`);
  return definition;
}

function languageProvider(type: ProviderType) {
  const definition = provider(type);
  if (!definition.createLanguageModel)
    throw new Error(`Missing language factory '${type}'`);
  return definition.createLanguageModel;
}

describe('native provider SDK construction', () => {
  it.each(['openai', 'anthropic', 'google-gemini', 'typesafe-ai'] as const)(
    'constructs the verified %s evaluation factory without inference',
    (type) => {
      const definition = provider(type);
      const factory = definition.createEvaluationModel;
      if (!factory) throw new Error('Missing evaluation factory');
      const model = factory(
        { id: 'test', type, settings: { apiKey: 'synthetic' } },
        'test-model',
      );
      expect(model.specificationVersion).toBe('v4');
      expect(model.modelId).toBe('test-model');
      expect(model.supportedQuestionTypes).toEqual(
        expect.arrayContaining(['boolean', 'choice']),
      );
      expect(Boolean(definition.createLanguageModel)).toBe(
        type !== 'typesafe-ai',
      );
    },
  );

  it('uses native TypeSafe URL/auth/headers, boolean transport, warnings and missing usage', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ answers: { flag: { type: 'noul', noul: 0.5 } } }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      const factory = provider('typesafe-ai').createEvaluationModel;
      if (!factory) throw new Error('Missing native factory');
      const model = factory(
        {
          id: 'native',
          type: 'typesafe-ai',
          settings: {
            apiKey: 'synthetic-key',
            baseUrl: 'https://synthetic.invalid/v1/',
            headers: { 'x-test': 'synthetic' },
          },
        },
        'jev-latest',
      );
      const result = await evaluate({
        model,
        state: 'synthetic',
        questions: { flag: { type: 'boolean', instructions: 'Flag?' } },
        providerOptions: { typesafe: { temperature: 0 } },
        maxRetries: 0,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://synthetic.invalid/v1/systemone');
      const headers = new Headers(options.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-key');
      expect(headers.get('x-test')).toBe('synthetic');
      expect(JSON.parse(options.body as string)).toEqual({
        model: 'jev-latest',
        state: 'synthetic',
        questions: { flag: { type: 'noul', instructions: 'Flag?' } },
      });
      expect(result.answers.flag).toEqual({
        type: 'boolean',
        probability: 0.5,
      });
      expect(result.usage.totalTokens).toBeUndefined();
      expect(result.warnings).toContainEqual({
        type: 'unsupported',
        feature: 'providerOptions.typesafe.temperature',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('creates an Azure OpenAI model with the native SDK', () => {
    const model = languageProvider('azure-openai')(
      {
        id: 'azure',
        type: 'azure-openai',
        settings: { apiKey: 'key', resourceName: 'resource' },
      },
      'test-model',
    );

    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('azure.responses');
    expect(model.modelId).toBe('test-model');
  });

  it('creates an Amazon Bedrock model with the native SDK', () => {
    const model = languageProvider('amazon-bedrock')(
      {
        id: 'bedrock',
        type: 'amazon-bedrock',
        settings: {
          authMode: 'access-keys',
          region: 'us-east-1',
          accessKeyId: 'id',
          secretAccessKey: 'secret',
        },
      },
      'test-model',
    );

    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('amazon-bedrock');
    expect(model.modelId).toBe('test-model');
  });

  it('creates a Google Vertex model with the native SDK', () => {
    const model = languageProvider('google-vertex')(
      {
        id: 'vertex',
        type: 'google-vertex',
        settings: {
          authMode: 'adc',
          project: 'project',
          location: 'us-central1',
        },
      },
      'test-model',
    );

    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('google.vertex.chat');
    expect(model.modelId).toBe('test-model');
  });
});
