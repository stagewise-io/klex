import { ProtocolError, SdkHttpError } from '@modelcontextprotocol/client';

/**
 * Lifecycle codes Klex Cloud sends while a managed computer wakes or waits for
 * host capacity. They are retryable even when an older proxy omits the hint.
 */
const TRANSIENT_LIFECYCLE_CODES: ReadonlySet<string> = new Set([
  'machine_starting',
  'capacity_wait',
]);
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_CAUSE_DEPTH = 4;

/** A failure the server described as temporary. */
export interface TransientMcpError {
  /** Server-suggested wait before retrying, when it sent one. */
  retryAfterMs?: number;
  /** Machine-readable code from the JSON-RPC error data, when present. */
  code?: string;
}

/**
 * Recognizes HTTP 503 responses and JSON-RPC errors whose data carries
 * `retryAfterSeconds` or a transient lifecycle code. Authentication and
 * authorization failures are never transient, whatever their body says.
 */
export function classifyTransientMcpError(
  error: unknown,
): TransientMcpError | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (current instanceof SdkHttpError) {
      const status = current.status;
      if (status === 401 || status === 403) return undefined;
      const hint = readHint(parseJsonRpcErrorData(current.data.text));
      if (status === 503 || isTransientHint(hint)) return hint;
      return undefined;
    }
    if (current instanceof ProtocolError) {
      const hint = readHint(current.data);
      return isTransientHint(hint) ? hint : undefined;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** Honors the server hint within bounds; otherwise backs off exponentially. */
export function transientRetryDelayMs(
  transient: TransientMcpError,
  attempt: number,
): number {
  const requested =
    transient.retryAfterMs ??
    MIN_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(Math.max(requested, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
}

/**
 * Model-facing failure after Klex exhausted its retries for a temporarily
 * unavailable server. The wording avoids billing or permission language from
 * the upstream error, which models read as a permanent failure.
 */
export class McpServerStartingError extends Error {
  readonly namespace: string;
  readonly code: string | undefined;
  readonly retryAfterMs: number;

  constructor(
    namespace: string,
    details: { code?: string; retryAfterMs: number; waitedMs: number },
    cause?: unknown,
  ) {
    const waitedSeconds = Math.max(1, Math.round(details.waitedMs / 1_000));
    const retrySeconds = Math.max(1, Math.round(details.retryAfterMs / 1_000));
    super(
      `MCP server "${namespace}" is temporarily unavailable: its computer is ` +
        `starting or reconnecting. Klex retried for ${waitedSeconds} s. This ` +
        'is temporary and does not mean the computer is broken, unpaid, or ' +
        `unauthorized. Wait about ${retrySeconds} s, then call the tool again.`,
      { cause },
    );
    this.name = 'McpServerStartingError';
    this.namespace = namespace;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
  }
}

function isTransientHint(hint: TransientMcpError): boolean {
  return (
    hint.retryAfterMs !== undefined ||
    (hint.code !== undefined && TRANSIENT_LIFECYCLE_CODES.has(hint.code))
  );
}

function readHint(data: unknown): TransientMcpError {
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const seconds = record.retryAfterSeconds;
  return {
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? { retryAfterMs: seconds * 1_000 }
      : {}),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
  };
}

function parseJsonRpcErrorData(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || !('error' in body)) return;
    const error = body.error;
    if (!error || typeof error !== 'object' || !('data' in error)) return;
    return error.data;
  } catch {
    return undefined;
  }
}
