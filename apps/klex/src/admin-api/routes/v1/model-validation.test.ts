import { describe, expect, it, vi } from 'vitest';

import { modelValidationResultSchema } from '@/provider-registry';

import { validateModel, validateModelRoute } from './model-validation';
import { setupTestApp } from './test-utils';

describe('POST /v1/models/test', () => {
  it('passes draft credentials, exact deployment and options without saving, and exports OpenAPI', async () => {
    const check = vi.fn(async () =>
      modelValidationResultSchema.parse({
        status: 'valid',
        code: 'available',
        message: 'Available',
        scope: 'language-generation',
      }),
    );
    const app = setupTestApp((app) =>
      app.openapi(
        validateModelRoute,
        validateModel({ providerRegistry: { validateModel: check } }),
      ),
    );
    const candidate = {
      provider: {
        type: 'azure-openai',
        settings: { apiKey: 'draft-key', resourceName: 'example' },
      },
      modelId: 'my-deployment',
      providerOptions: { azure: { reasoningEffort: 'low' } },
    };
    const response = await app.request('/v1/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidate),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(check).toHaveBeenCalledWith(
      { ...candidate, purpose: 'chat' },
      expect.any(AbortSignal),
    );
    expect(await response.text()).not.toContain('draft-key');
    expect(
      app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: { title: 'test', version: '1' },
      }).paths,
    ).toHaveProperty('/v1/models/test');
  });

  it('rejects malformed and oversized candidates before invoking the provider', async () => {
    const check = vi.fn();
    const app = setupTestApp((app) =>
      app.openapi(
        validateModelRoute,
        validateModel({ providerRegistry: { validateModel: check } }),
      ),
    );
    for (const [body, status] of [
      [{ provider: { id: 'openai' }, modelId: '' }, 400],
      [
        {
          provider: { id: 'openai' },
          modelId: 'gpt',
          prompt: 'arbitrary prompt',
        },
        400,
      ],
      [
        {
          provider: {
            type: 'openai',
            settings: { apiKey: 'x'.repeat(70_000) },
          },
          modelId: 'gpt',
        },
        413,
      ],
    ] as const) {
      const response = await app.request('/v1/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
    }
    expect(check).not.toHaveBeenCalled();
  });
});
