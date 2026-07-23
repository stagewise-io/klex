import { APICallError, EmptyResponseBodyError } from 'ai';
import { describe, expect, it } from 'vitest';

import { classifyGenerationError } from './classify-generation-error';

/** Creates an APICallError with the required fields pre-filled. */
function makeApiError(opts: {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    ...opts,
  });
}

describe('classifyGenerationError', () => {
  describe('null / undefined / string inputs', () => {
    it('classifies null as model error', () => {
      const result = classifyGenerationError(null);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toBe('model reported error without details');
    });

    it('classifies undefined as model error', () => {
      const result = classifyGenerationError(undefined);
      expect(result.isModelError).toBe(true);
    });

    it('classifies string as model error', () => {
      const result = classifyGenerationError('rate limit exceeded');
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('rate limit exceeded');
    });
  });

  describe('APICallError', () => {
    it('classifies 500 as model error', () => {
      const error = makeApiError({
        message: 'Internal Server Error',
        statusCode: 500,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('500');
    });

    it('classifies 503 as model error', () => {
      const error = makeApiError({
        message: 'Service Unavailable',
        statusCode: 503,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
    });

    it('classifies 429 as model error', () => {
      const error = makeApiError({
        message: 'Too Many Requests',
        statusCode: 429,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('429');
    });

    it('classifies 400 as non-model error', () => {
      const error = makeApiError({
        message: 'Bad Request',
        statusCode: 400,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(false);
      expect(result.reason).toContain('400');
    });

    it('classifies 401 as non-model error', () => {
      const error = makeApiError({
        message: 'Unauthorized',
        statusCode: 401,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(false);
    });

    it('classifies retryable error without status code as model error', () => {
      const error = makeApiError({
        message: 'Transient failure',
        isRetryable: true,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('retryable');
    });

    it('classifies non-retryable error without status code as non-model', () => {
      const error = makeApiError({
        message: 'Permanent failure',
        isRetryable: false,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(false);
      expect(result.reason).toContain('non-retryable');
    });
  });

  describe('EmptyResponseBodyError', () => {
    it('classifies as model error', () => {
      const error = new EmptyResponseBodyError({
        message: 'Empty response',
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('empty response body');
    });
  });

  describe('network errors', () => {
    it('classifies timeout as model error', () => {
      const error = new Error('Request timeout after 30000ms');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('network error');
    });

    it('classifies ECONNREFUSED as model error', () => {
      const error = new Error('fetch failed: ECONNREFUSED 127.0.0.1:8080');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
    });

    it('classifies ECONNRESET as model error', () => {
      const error = new Error('socket hang up: ECONNRESET');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
    });

    it('classifies "fetch failed" as model error', () => {
      const error = new Error('fetch failed');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
    });

    it('classifies "socket hang up" as model error', () => {
      const error = new Error('socket hang up');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
    });
  });

  describe('unknown errors', () => {
    it('classifies generic Error as non-model error', () => {
      const error = new Error('something went wrong');
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(false);
      expect(result.reason).toBe('unknown error');
    });

    it('classifies non-Error object as non-model error', () => {
      const result = classifyGenerationError({ foo: 'bar' });
      expect(result.isModelError).toBe(false);
      expect(result.reason).toBe('unknown error');
    });
  });
});
