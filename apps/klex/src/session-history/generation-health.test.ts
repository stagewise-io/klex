import { APICallError, NoOutputGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';

import { summarizeGenerationFailure } from './generation-health';

describe('privacy-safe generation health', () => {
  it.each(['api key', 'authentication', 'configuration', 'unsupported'])(
    'preserves 429 rate-limit and quota classifications when the message mentions %s',
    (wording) => {
      for (const [message, category, reason] of [
        ['Rate limit reached TPM: 30000', 'rate_limit', 'rate limited (429)'],
        ['Billing quota exhausted', 'quota', 'quota exhausted (429)'],
      ]) {
        const error = new APICallError({
          statusCode: 429,
          message: `${message}; check ${wording}`,
          url: 'https://provider.example',
          requestBodyValues: {},
        });
        expect(summarizeGenerationFailure(error)).toMatchObject({
          category,
          reason,
          statusCode: 429,
        });
      }
    },
  );

  it.each([
    [
      429,
      'Quota exceeded for metric generate_content_free_tier_requests per minute',
      'rate_limit',
    ],
    [429, 'You exceeded your current quota, check billing', 'quota'],
    [
      429,
      'Rate limit reached on tokens per minute TPM: 30000 RPM: 500',
      'rate_limit',
    ],
    [429, 'insufficient_quota', 'quota'],
    [
      429,
      'Rate limit reached on tokens per min (TPM): Limit 30000, Used 29900, Requested 500',
      'rate_limit',
    ],
    [401, 'Unauthorized', 'auth'],
    [403, 'Forbidden', 'auth'],
    [404, 'Model missing', 'configuration'],
    [408, 'timeout', 'connectivity'],
    [529, 'Overloaded', 'server_error'],
    [400, 'Bad input', 'request_rejected'],
  ])('classifies %s %s', (statusCode, message, category) => {
    const error = new APICallError({
      statusCode,
      message,
      url: 'https://secret.example',
      requestBodyValues: {},
    });
    const result = summarizeGenerationFailure(error, {
      providerId: 'primary',
      providerType: 'google',
      modelId: 'gemini-2.5-pro',
    });
    expect(result).toMatchObject({
      category,
      statusCode,
      providerId: 'primary',
      providerType: 'google',
      modelId: 'gemini-2.5-pro',
    });
  });

  it('unwraps SDK failures and preserves numeric rate limits without arbitrary provider prose', () => {
    const secret =
      'private-prompt sk-secret Bearer secret-token AIza123 https://secret.example user@example.com headers: payload';
    const cause = new APICallError({
      statusCode: 429,
      message: `TPM: 30000 RPM: 500 ${secret}`,
      url: 'https://secret.example',
      requestBodyValues: { prompt: secret },
      responseBody: secret,
      responseHeaders: { authorization: secret },
    });
    const result = summarizeGenerationFailure(
      new NoOutputGeneratedError({ cause }),
      {
        providerId: 'sk-secret',
        providerType: 'openai',
        modelId: 'https://secret.example',
      },
    );
    expect(result.message).toContain('TPM: 30000 RPM: 500');
    expect(result.reason).toBe('rate limited (429)');
    expect(result.providerId).toBeNull();
    expect(result.modelId).toBeNull();
    for (const value of secret.split(' '))
      expect(JSON.stringify(result)).not.toContain(value);
  });

  it('does not echo arbitrary prompts even when no recognizable secret markers exist', () => {
    const result = summarizeGenerationFailure(
      new Error('private user prose '.repeat(10000)),
    );
    expect(result.category).toBe('unknown');
    expect(result.message).not.toContain('private user prose');
    expect(result.message.length).toBeLessThanOrEqual(512);
  });
});
