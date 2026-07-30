import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
} from 'ai';
import { describe, expect, it } from 'vitest';

import { classifyGenerationError } from './classify-generation-error';

/** Creates a DOMException-like AbortError. */
function makeAbortError(
  name = 'AbortError',
  message = 'The operation was aborted',
): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

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
      expect(result.isAbort).toBe(false);
      expect(result.reason).toBe('model reported error without details');
    });

    it('classifies undefined as model error', () => {
      const result = classifyGenerationError(undefined);
      expect(result.isModelError).toBe(true);
      expect(result.isAbort).toBe(false);
    });

    it('classifies string as model error', () => {
      const result = classifyGenerationError('rate limit exceeded');
      expect(result.isModelError).toBe(true);
      expect(result.isAbort).toBe(false);
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

    it('classifies 401 as model error (auth failure triggers fallback)', () => {
      const error = makeApiError({
        message: 'Unauthorized',
        statusCode: 401,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('401');
    });

    it('classifies 403 as model error (auth failure triggers fallback)', () => {
      const error = makeApiError({
        message: 'Forbidden',
        statusCode: 403,
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('403');
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

  describe('NoOutputGeneratedError', () => {
    it('classifies as model error', () => {
      const error = new NoOutputGeneratedError({
        message: 'No output generated. Check the stream for errors.',
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('no output generated');
    });
  });

  describe('NoContentGeneratedError', () => {
    it('classifies as model error', () => {
      const error = new NoContentGeneratedError({});
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('no content generated');
    });
  });

  describe('LoadAPIKeyError', () => {
    it('classifies as model error', () => {
      const error = new LoadAPIKeyError({ message: 'API key not found' });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('load API key');
    });
  });

  describe('NoSuchModelError', () => {
    it('classifies as model error', () => {
      const error = new NoSuchModelError({
        modelId: 'gpt-99',
        modelType: 'languageModel',
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('no such model');
    });
  });

  describe('JSONParseError', () => {
    it('classifies as model error', () => {
      const error = new JSONParseError({
        text: 'invalid',
        cause: new SyntaxError('Unexpected token'),
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('JSON parse');
    });
  });

  describe('InvalidResponseDataError', () => {
    it('classifies as model error', () => {
      const error = new InvalidResponseDataError({ data: null });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('invalid response data');
    });
  });

  describe('UnsupportedFunctionalityError', () => {
    it('classifies as model error', () => {
      const error = new UnsupportedFunctionalityError({
        functionality: 'tool calling',
      });
      const result = classifyGenerationError(error);
      expect(result.isModelError).toBe(true);
      expect(result.reason).toContain('unsupported functionality');
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
      expect(result.isAbort).toBe(false);
      expect(result.reason).toBe('unknown error');
    });

    it('classifies non-Error object as non-model error', () => {
      const result = classifyGenerationError({ foo: 'bar' });
      expect(result.isModelError).toBe(false);
      expect(result.isAbort).toBe(false);
      expect(result.reason).toBe('unknown error');
    });
  });

  describe('abort errors', () => {
    it('classifies AbortError as abort (not model error)', () => {
      const error = makeAbortError('AbortError');
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(true);
      expect(result.isModelError).toBe(false);
      expect(result.isFatal).toBe(false);
      expect(result.reason).toBe('generation aborted');
    });

    it('classifies TimeoutError as abort (from setAbortTimeout)', () => {
      const error = makeAbortError(
        'TimeoutError',
        'Chunk timeout of 10000ms exceeded',
      );
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(true);
      expect(result.isModelError).toBe(false);
    });

    it('classifies error with "aborted" in message as abort', () => {
      const error = new Error('This operation was aborted');
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(true);
      expect(result.isModelError).toBe(false);
    });

    it('classifies DOMException AbortError as abort', () => {
      const error = new DOMException('The operation was aborted', 'AbortError');
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(true);
      expect(result.isModelError).toBe(false);
    });

    it('classifies NoOutputGeneratedError wrapping AbortError as abort', () => {
      const abortError = makeAbortError('AbortError');
      const error = new NoOutputGeneratedError({
        message: 'No output generated.',
        cause: abortError,
      });
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(true);
      expect(result.isModelError).toBe(false);
      expect(result.reason).toContain('aborted');
    });

    it('does NOT classify timeout network error as abort (different from abort signal)', () => {
      // A plain "timeout" string in the message without an abort signal
      // is a network-level timeout, not an abort. It should be treated as
      // a model error (retryable), not an abort.
      const error = new Error('Request timeout after 30000ms');
      const result = classifyGenerationError(error);
      expect(result.isAbort).toBe(false);
      expect(result.isModelError).toBe(true);
    });
  });
});
