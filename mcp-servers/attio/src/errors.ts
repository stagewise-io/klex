import { randomUUID } from 'node:crypto';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'RECONNECT_REQUIRED'
  | 'INVALID_STATE'
  | 'UPSTREAM_ERROR'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'CAPABILITY_UNAVAILABLE';
const messages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Invalid input.',
  UNAUTHORIZED: 'Authentication required.',
  NOT_FOUND: 'Resource not found.',
  PERMISSION_DENIED: 'Access denied.',
  CONFLICT: 'Record conflicts with an existing value.',
  RECONNECT_REQUIRED: 'Reconnect this Attio connection.',
  INVALID_STATE: 'Authorization attempt is invalid or expired.',
  UPSTREAM_ERROR: 'Invalid Attio response.',
  UNAVAILABLE: 'Service temporarily unavailable.',
  RATE_LIMITED: 'Attio rate limit reached.',
  WRITE_OUTCOME_UNKNOWN:
    'The write may have completed. Verify with get or query before trying again.',
  CAPABILITY_UNAVAILABLE: 'Attio search is unavailable for this request.',
};
export class AttioError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(messages[code]);
  }
}
export function safeError(error: unknown) {
  const safe =
    error instanceof AttioError ? error : new AttioError('UNAVAILABLE');
  return {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    ...(safe.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: safe.retryAfterMs }),
    ...(safe.code === 'WRITE_OUTCOME_UNKNOWN' ? { outcome: 'unknown' } : {}),
    correlationId: randomUUID(),
  };
}
