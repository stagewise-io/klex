import { APICallError, EmptyResponseBodyError } from 'ai';

export interface GenerationErrorClassification {
  isModelError: boolean;
  reason: string;
}

/**
 * Classifies a generation error (thrown exception or `error` finish reason
 * payload) to determine whether it is model/provider-related and should
 * trigger a model fallback.
 *
 * Model errors: 5xx, 429, retryable API errors, empty response, network
 * errors (timeout, connection refused/reset, fetch failures).
 *
 * Non-model errors: 4xx (except 429), non-retryable API errors, content
 * filter responses, unknown errors.
 */
export function classifyGenerationError(
  error: unknown,
): GenerationErrorClassification {
  // Null/undefined — only expected when the model reports an error finish
  // reason without providing details. Treat as model error.
  if (error == null) {
    return {
      isModelError: true,
      reason: 'model reported error without details',
    };
  }

  // String — could be a raw provider finish reason. Treat as model error.
  if (typeof error === 'string') {
    return { isModelError: true, reason: `model error: ${error}` };
  }

  // APICallError — classify based on status code and retryability.
  if (APICallError.isInstance(error)) {
    if (error.statusCode !== undefined) {
      if (error.statusCode >= 500 || error.statusCode === 429) {
        return {
          isModelError: true,
          reason: `server error (${error.statusCode})`,
        };
      }
      if (error.statusCode >= 400) {
        return {
          isModelError: false,
          reason: `client error (${error.statusCode})`,
        };
      }
    }
    if (error.isRetryable) {
      return { isModelError: true, reason: 'retryable API error' };
    }
    return { isModelError: false, reason: 'non-retryable API error' };
  }

  // EmptyResponseBodyError — model returned nothing. Model error.
  if (error instanceof EmptyResponseBodyError) {
    return { isModelError: true, reason: 'empty response body' };
  }

  // Other errors — check for network-related patterns.
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up')
    ) {
      return {
        isModelError: true,
        reason: `network error: ${error.message}`,
      };
    }
  }

  return { isModelError: false, reason: 'unknown error' };
}
