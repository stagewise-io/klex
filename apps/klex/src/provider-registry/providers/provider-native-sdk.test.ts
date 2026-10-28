import { describe, expect, it } from 'vitest';

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
  it.each([
    ['gpt-audio-1.5', 'openai.chat'],
    ['gpt-audio-future', 'openai.chat'],
    ['gpt-4.1', 'openai.responses'],
  ])('routes OpenAI %s through %s', (modelId, expectedProvider) => {
    const model = languageProvider('openai')(
      { id: 'openai', type: 'openai', settings: { apiKey: 'synthetic' } },
      modelId,
    );

    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe(expectedProvider);
    expect(model.modelId).toBe(modelId);
  });

  it.each([
    'openai',
    'anthropic',
    'google-gemini',
    'typesafe-ai',
    'vercel-ai-gateway',
  ] as const)(
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
