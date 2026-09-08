import { createGoogleVertex } from '@ai-sdk/google-vertex';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveGoogleModelMetadata } from './google-gemini';
import { isRecord, setting, testModelConnection } from './shared';

export const googleVertexProviderDefinition: ProviderDefinition = {
  type: 'google-vertex',
  usageGuidance:
    'Use for Gemini models hosted through Google Vertex AI. Choose ADC, service-account JSON, or Vertex Express authentication.',
  metadata: {
    displayName: 'Google Vertex AI',
    description: 'Gemini models hosted through Google Vertex AI.',
    documentationUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs',
  },
  resolveModelMetadata: resolveGoogleModelMetadata,
  createLanguageModel,
  testConnection: (instance, signal) =>
    testModelConnection(
      instance,
      'https://aiplatform.googleapis.com',
      (modelId) => createLanguageModel(instance, modelId),
      signal,
    ),
};

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  const authMode = setting(instance, 'authMode');
  const credentials =
    authMode === 'service-account'
      ? parseCredentials(instance.settings.googleCredentials)
      : undefined;
  const project = setting(instance, 'project') ?? credentials?.project_id;
  return createGoogleVertex({
    ...(project && { project }),
    location: setting(instance, 'location') ?? 'us-central1',
    ...(authMode === 'api-key' &&
      setting(instance, 'apiKey') && { apiKey: setting(instance, 'apiKey') }),
    ...(credentials && { googleAuthOptions: { credentials } }),
  }).languageModel(modelId);
}

function parseCredentials(value: unknown):
  | {
      client_email: string;
      private_key: string;
      project_id?: string;
    }
  | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Service account JSON is invalid');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.client_email !== 'string' ||
    !parsed.client_email.trim() ||
    typeof parsed.private_key !== 'string' ||
    !parsed.private_key.trim()
  ) {
    throw new Error(
      'Service account JSON must contain client_email and private_key',
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    ...(typeof parsed.project_id === 'string' &&
      parsed.project_id.trim() && { project_id: parsed.project_id }),
  };
}
