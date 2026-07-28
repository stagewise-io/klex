import {
  APICallError,
  EmptyResponseBodyError,
  InvalidPromptError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
} from 'ai';

export interface GenerationErrorClassification {
  isModelError: boolean;
  /**
   * True when the error is non-recoverable — the request itself is
   * invalid (e.g. 400 bad request, invalid prompt). The session should
   * be terminated rather than retried, because no model or delay will
   * fix a malformed request.
   */
  isFatal: boolean;
  reason: string;
}

/** A constructor function for an AI SDK error class. */
type ErrorConstructor =
  | (abstract new (
      ...args: unknown[]
    ) => Error)
  | { isInstance: (e: unknown) => boolean };

/** Check if an error matches the given constructor or static isInstance guard. */
function matches(error: unknown, cls: ErrorConstructor): boolean {
  if (typeof cls === 'function') return error instanceof cls;
  if (typeof cls === 'object' && cls !== null && 'isInstance' in cls) {
    return cls.isInstance(error);
  }
  return false;
}

/**
 * Simple type-based classifiers — each entry is a direct instanceof /
 * `.isInstance()` check producing a fixed classification. Complex cases
 * (APICallError, NoOutputGeneratedError, network errors) are handled
 * inline below.
 */
const SIMPLE_CLASSIFIERS: Array<{
  cls: ErrorConstructor;
  result: GenerationErrorClassification;
}> = [
  {
    cls: EmptyResponseBodyError,
    result: {
      isModelError: true,
      isFatal: false,
      reason: 'empty response body',
    },
  },
  {
    cls: NoContentGeneratedError,
    result: {
      isModelError: true,
      isFatal: false,
      reason: 'no content generated',
    },
  },
  {
    cls: LoadAPIKeyError,
    result: {
      isModelError: true,
      isFatal: false,
      reason: 'failed to load API key',
    },
  },
  {
    cls: NoSuchModelError,
    result: { isModelError: true, isFatal: false, reason: 'no such model' },
  },
  {
    cls: JSONParseError,
    result: { isModelError: true, isFatal: false, reason: 'JSON parse error' },
  },
  {
    cls: InvalidResponseDataError,
    result: {
      isModelError: true,
      isFatal: false,
      reason: 'invalid response data',
    },
  },
  {
    cls: InvalidPromptError,
    result: {
      isModelError: false,
      isFatal: true,
      reason: 'invalid prompt error',
    },
  },
  {
    cls: UnsupportedFunctionalityError,
    result: {
      isModelError: true,
      isFatal: false,
      reason: 'unsupported functionality',
    },
  },
];

/**
 * Classifies a generation error (thrown exception or `error` finish reason
 * payload) to determine whether it is model/provider-related and should
 * trigger a model fallback.
 *
 * Model errors: 5xx, 429, 401/403 (auth), retryable API errors, empty
 * response, no-output-generated, no-content-generated, load-api-key,
 * no-such-model, JSON parse, invalid response data, unsupported
 * functionality, network errors (timeout, connection refused/reset,
 * fetch failures).
 *
 * Non-model errors: 4xx (except 401/403/429), non-retryable API errors,
 * invalid prompt, content filter responses, unknown errors.
 */
export function classifyGenerationError(
  error: unknown,
): GenerationErrorClassification {
  // Null/undefined — only expected when the model reports an error finish
  // reason without providing details. Treat as model error.
  if (error == null) {
    return {
      isModelError: true,
      isFatal: false,
      reason: 'model reported error without details',
    };
  }

  // String — could be a raw provider finish reason. Treat as model error.
  if (typeof error === 'string') {
    return {
      isModelError: true,
      isFatal: false,
      reason: `model error: ${error}`,
    };
  }

  // APICallError — classify based on status code and retryability.
  if (APICallError.isInstance(error)) {
    if (error.statusCode !== undefined) {
      if (error.statusCode >= 500 || error.statusCode === 429) {
        return {
          isModelError: true,
          isFatal: false,
          reason: `server error (${error.statusCode})`,
        };
      }
      // 401/403 are authentication/authorization errors — the provider
      // is misconfigured or the key is invalid. Treat as model error so
      // fallback to the next model/provider is triggered.
      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          isModelError: true,
          isFatal: false,
          reason: `authentication error (${error.statusCode})`,
        };
      }
      // 400 and other 4xx (except auth) are bad-request errors. The
      // request itself is malformed — retrying with a different model or
      // after a delay will not help. Mark as fatal so the session is
      // terminated.
      if (error.statusCode === 400) {
        return {
          isModelError: false,
          isFatal: true,
          reason: `bad request (${error.statusCode})`,
        };
      }
      if (error.statusCode >= 400) {
        return {
          isModelError: false,
          isFatal: false,
          reason: `client error (${error.statusCode})`,
        };
      }
    }
    if (error.isRetryable) {
      return {
        isModelError: true,
        isFatal: false,
        reason: 'retryable API error',
      };
    }
    return {
      isModelError: false,
      isFatal: false,
      reason: 'non-retryable API error',
    };
  }

  // NoOutputGeneratedError — the AI SDK wraps provider failures (e.g. 401,
  // 500) into this error when no stream content was produced. The original
  // error is preserved as `cause`. Recurse into the cause so the real
  // error is classified with an accurate reason and fatal/model-error
  // semantics. Only fall back to a generic model error when there is no
  // cause to inspect.
  if (NoOutputGeneratedError.isInstance(error)) {
    if (error.cause != null) {
      const inner = classifyGenerationError(error.cause);
      return {
        ...inner,
        reason: `${inner.reason} (no output generated)`,
      };
    }
    return {
      isModelError: true,
      isFatal: false,
      reason: 'no output generated',
    };
  }

  // Simple type-based classifiers — table-driven for straightforward cases.
  for (const { cls, result } of SIMPLE_CLASSIFIERS) {
    if (matches(error, cls)) {
      return result;
    }
  }

  // Network-related errors — check message patterns.
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
        isFatal: false,
        reason: `network error: ${error.message}`,
      };
    }
  }

  return {
    isModelError: false,
    isFatal: false,
    reason: 'unknown error',
  };
}
