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

/**
 * Checks whether an error is an abort error. Abort errors are produced by:
 * - `AbortController.abort()` → `DOMException` with name `'AbortError'`
 * - `AbortSignal.timeout()` → `DOMException` with name `'TimeoutError'`
 *   (also caught here because timeout-aborted signals produce abort-like
 *   behavior in the streaming layer)
 * - Node.js native `AbortError` (name property check)
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Standard DOMException-based abort (browser + Node 18+).
  if (error.name === 'AbortError') return true;
  // TimeoutError from AbortSignal.timeout / setAbortTimeout — these
  // abort the stream via the abort controller, so treat as abort.
  if (error.name === 'TimeoutError') return true;
  // Some Node.js environments produce errors with 'aborted' in the
  // message when an AbortSignal fires during fetch.
  const msg = error.message.toLowerCase();
  if (msg.includes('aborted') || msg.includes('this operation was aborted')) {
    return true;
  }
  return false;
}

export interface GenerationErrorClassification {
  isModelError: boolean;
  /**
   * True when the error is non-recoverable — the prompt was rejected
   * locally as invalid (e.g. `InvalidPromptError`). The session should
   * be terminated rather than retried. Provider HTTP 4xx responses
   * (including 400) are never fatal; they set `isRequestRejected`.
   */
  isFatal: boolean;
  /**
   * True when the error was caused by an abort (AbortError, DOMException
   * with name 'AbortError', or a signal-aborted timeout). Aborts are
   * user-initiated or system-initiated interruptions, not model failures
   * — they must NOT trigger model fallback.
   */
  isAbort: boolean;
  /**
   * True when the provider rejected this specific request (4xx other than
   * 401/403/408/429). Retrying the identical request will not help;
   * changing request content (e.g. dropping remote media) or the model
   * might. Never combined with `isFatal` or `isModelError`.
   */
  isRequestRejected: boolean;
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
      isAbort: false,
      isRequestRejected: false,
      reason: 'empty response body',
    },
  },
  {
    cls: NoContentGeneratedError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'no content generated',
    },
  },
  {
    cls: LoadAPIKeyError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'failed to load API key',
    },
  },
  {
    cls: NoSuchModelError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'no such model',
    },
  },
  {
    cls: JSONParseError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'JSON parse error',
    },
  },
  {
    cls: InvalidResponseDataError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'invalid response data',
    },
  },
  {
    cls: InvalidPromptError,
    result: {
      isModelError: false,
      isFatal: true,
      isAbort: false,
      isRequestRejected: false,
      reason: 'invalid prompt error',
    },
  },
  {
    cls: UnsupportedFunctionalityError,
    result: {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: 'unsupported functionality',
    },
  },
];

/**
 * Classifies a generation error (thrown exception or `error` finish reason
 * payload) to determine whether it is model/provider-related and should
 * trigger a model fallback.
 *
 * Model errors: 5xx, 429, 408, 401/403 (auth), retryable API errors,
 * empty response, no-output-generated, no-content-generated, load-api-key,
 * no-such-model, JSON parse, invalid response data, unsupported
 * functionality, network errors (timeout, connection refused/reset,
 * fetch failures).
 *
 * Request rejections: other 4xx (including 400). The provider refused
 * this specific request — e.g. a remote file it could not fetch. These
 * are neither fatal nor model errors.
 *
 * Fatal: invalid prompt (raised locally before any request).
 *
 * Other non-model errors: non-retryable API errors without status,
 * content filter responses, unknown errors.
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
      isAbort: false,
      isRequestRejected: false,
      reason: 'model reported error without details',
    };
  }

  // String — could be a raw provider finish reason. Treat as model error.
  if (typeof error === 'string') {
    return {
      isModelError: true,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
      reason: `model error: ${error}`,
    };
  }

  // Abort detection — check before all other classifiers so that aborts
  // are never misclassified as model errors. Aborts can be triggered by:
  // - User-initiated cancellation (AbortController.abort())
  // - Session shutdown
  // - Inbox interrupt (high-priority event preempts current generation)
  // Aborts must NOT trigger model fallback.
  if (isAbortError(error)) {
    return {
      isModelError: false,
      isFatal: false,
      isAbort: true,
      isRequestRejected: false,
      reason: 'generation aborted',
    };
  }

  // APICallError — classify based on status code and retryability.
  if (APICallError.isInstance(error)) {
    if (error.statusCode !== undefined) {
      if (error.statusCode >= 500 || error.statusCode === 429) {
        return {
          isModelError: true,
          isFatal: false,
          isAbort: false,
          isRequestRejected: false,
          reason: `server error (${error.statusCode})`,
        };
      }
      // 408 is a request timeout — transient, so retry like a network
      // error with fallback.
      if (error.statusCode === 408) {
        return {
          isModelError: true,
          isFatal: false,
          isAbort: false,
          isRequestRejected: false,
          reason: `request timeout (${error.statusCode})`,
        };
      }
      // 401/403 are authentication/authorization errors — the provider
      // is misconfigured or the key is invalid. Treat as model error so
      // fallback to the next model/provider is triggered.
      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          isModelError: true,
          isFatal: false,
          isAbort: false,
          isRequestRejected: false,
          reason: `authentication error (${error.statusCode})`,
        };
      }
      // 400 and other 4xx (except auth/timeout/rate limit): the provider
      // rejected this specific request, e.g. because a remote file it
      // had to fetch was unusable. Retrying the identical request will
      // not help, but the session must stay alive — the turn degrades
      // request content once and then stops.
      if (error.statusCode >= 400 && error.statusCode < 500) {
        return {
          isModelError: false,
          isFatal: false,
          isAbort: false,
          isRequestRejected: true,
          reason: `request rejected (${error.statusCode})`,
        };
      }
    }
    if (error.isRetryable) {
      return {
        isModelError: true,
        isFatal: false,
        isAbort: false,
        isRequestRejected: false,
        reason: 'retryable API error',
      };
    }
    return {
      isModelError: false,
      isFatal: false,
      isAbort: false,
      isRequestRejected: false,
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
      isAbort: false,
      isRequestRejected: false,
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
        isAbort: false,
        isRequestRejected: false,
        reason: 'network error',
      };
    }
  }

  return {
    isModelError: false,
    isFatal: false,
    isAbort: false,
    isRequestRejected: false,
    reason: 'unknown error',
  };
}
