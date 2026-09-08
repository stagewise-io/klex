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

describe('native provider SDK construction', () => {
  it('creates an Azure OpenAI model with the native SDK', () => {
    const model = provider('azure-openai').createLanguageModel(
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
    const model = provider('amazon-bedrock').createLanguageModel(
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
    const model = provider('google-vertex').createLanguageModel(
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
