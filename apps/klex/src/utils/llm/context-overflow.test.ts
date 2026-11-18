import { APICallError, NoOutputGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';

import { isContextOverflowError } from './context-overflow';

function apiError(
  message: string,
  statusCode = 400,
  responseBody?: string,
): APICallError {
  return new APICallError({
    message,
    statusCode,
    url: 'https://api.example.com/v1/responses',
    requestBodyValues: {},
    ...(responseBody !== undefined && { responseBody }),
  });
}

describe('isContextOverflowError', () => {
  it.each([
    'Your input exceeds the context window of this model.',
    "This model's maximum context length is 128000 tokens.",
    'prompt is too long: 210000 tokens > 200000 maximum',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
  ])('detects %s', (message) => {
    expect(isContextOverflowError(apiError(message))).toBe(true);
  });

  it('detects the error code in the response body', () => {
    expect(
      isContextOverflowError(
        apiError(
          'Bad Request',
          400,
          '{"error":{"code":"context_length_exceeded"}}',
        ),
      ),
    ).toBe(true);
  });

  it('unwraps no-output and stream error envelopes', () => {
    expect(
      isContextOverflowError(
        new NoOutputGeneratedError({
          cause: apiError(
            'Your input exceeds the context window of this model.',
          ),
        }),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError({
        type: 'error',
        error: { code: 'context_length_exceeded', message: 'Too long' },
      }),
    ).toBe(true);
  });

  it('ignores other rejections and rate limits', () => {
    expect(isContextOverflowError(apiError('Invalid image URL'))).toBe(false);
    expect(
      isContextOverflowError(
        apiError('Request too large: maximum context length exceeded', 429),
      ),
    ).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});
