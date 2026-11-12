import { GPT_LIVE_MAX_TRANSCRIPT_DELTA_CHARACTERS } from './transcript-groups';

export const GPT_LIVE_MAX_AUDIO_DELTA_BYTES = 96_000;
export const GPT_LIVE_MAX_FUNCTION_ARGUMENT_CHARACTERS = 65_536;
const GPT_LIVE_MAX_AUDIO_DELTA_BASE64_CHARACTERS =
  Math.ceil(GPT_LIVE_MAX_AUDIO_DELTA_BYTES / 3) * 4;

export interface GPTLiveProviderError {
  readonly type: string;
  readonly code: string;
  readonly message: string;
  readonly param?: string;
  readonly clientEventId?: string;
}

export interface GPTLiveFunctionCall {
  readonly itemId?: string;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export type GPTLiveServerEvent =
  | { readonly type: 'session-started'; readonly sessionId: string }
  | {
      readonly type: 'session-closed';
      readonly sessionId: string;
      readonly reason:
        | 'close_requested'
        | 'expired'
        | 'content'
        | 'remote_hangup'
        | 'connection_lost';
      readonly usageSeconds: number;
    }
  | { readonly type: 'provider-error'; readonly error: GPTLiveProviderError }
  | {
      readonly type: 'transcript-delta';
      readonly speaker: 'user' | 'assistant';
      readonly eventId: string;
      readonly delta: string;
      readonly startMs: number;
      readonly endMs: number;
    }
  | { readonly type: 'output-audio-delta'; readonly delta: string }
  | {
      readonly type: 'usage-updated';
      readonly usageSeconds: number;
      readonly contextWindowRatio?: number;
    }
  | {
      readonly type: 'delegation-created';
      readonly delegationId: string;
      readonly responseId: string;
      readonly offsetMs: number;
    }
  | {
      readonly type: 'response-started';
      readonly delegationId: string;
      readonly responseId: string;
    }
  | {
      readonly type: 'response-function-call';
      readonly delegationId: string;
      readonly call: GPTLiveFunctionCall;
    }
  | {
      readonly type: 'response-terminal';
      readonly delegationId: string;
      readonly responseId: string;
      readonly status: 'completed' | 'failed';
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  | {
      readonly type: 'response-error';
      readonly delegationId: string;
      readonly code?: string;
      readonly message: string;
    }
  | { readonly type: 'ignored'; readonly name: string };

export class GPTLiveWireEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GPTLiveWireEventError';
    Object.setPrototypeOf(this, GPTLiveWireEventError.prototype);
  }
}

export function parseLiveServerEvent(raw: unknown): GPTLiveServerEvent {
  const parsed = parseLiveEventJson(raw);
  const event = requiredRecord(parsed, 'Live event');
  const name = requiredString(event.type, 'Live event', 'type');

  switch (name) {
    case 'session.started':
      return {
        type: 'session-started',
        sessionId: requiredString(
          requiredRecord(event.session, name).id,
          name,
          'session.id',
        ),
      };

    case 'session.closed': {
      const session = requiredRecord(event.session, name);
      const usage = requiredRecord(event.usage, name);
      return {
        type: 'session-closed',
        sessionId: requiredString(session.id, name, 'session.id'),
        reason: closeReason(event.reason, name),
        usageSeconds: nonNegativeNumber(usage.seconds, name, 'usage.seconds'),
      };
    }

    // Error events describe a failure; their shape must never cause another.
    case 'error': {
      const error = optionalRecord(event.error) ?? {};
      return {
        type: 'provider-error',
        error: {
          type: truncate(errorField(error.type) ?? 'unknown'),
          code: truncate(errorField(error.code) ?? 'unknown'),
          message: truncate(
            errorField(error.message) ?? 'GPT-Live reported an error',
          ),
          ...withKey('param', truncate(errorField(error.param))),
          ...withKey(
            'clientEventId',
            truncate(optionalString(error.client_event_id)),
          ),
        },
      };
    }

    case 'session.input_transcript.delta':
    case 'session.output_transcript.delta': {
      const startMs = nonNegativeNumber(event.start_ms, name, 'start_ms');
      const endMs = nonNegativeNumber(event.end_ms, name, 'end_ms');
      if (endMs < startMs)
        throw new GPTLiveWireEventError(`${name} has end_ms before start_ms`);
      return {
        type: 'transcript-delta',
        speaker:
          name === 'session.input_transcript.delta' ? 'user' : 'assistant',
        eventId: requiredString(event.event_id, name, 'event_id'),
        delta: boundedString(
          event.delta,
          name,
          'delta',
          GPT_LIVE_MAX_TRANSCRIPT_DELTA_CHARACTERS,
        ),
        startMs,
        endMs,
      };
    }

    case 'session.output_audio.delta':
      return {
        type: 'output-audio-delta',
        delta: requiredBase64(
          event.delta,
          name,
          'delta',
          GPT_LIVE_MAX_AUDIO_DELTA_BASE64_CHARACTERS,
        ),
      };

    case 'session.usage.updated': {
      const usage = requiredRecord(event.usage, name);
      const contextWindow = optionalRecord(event.context_window);
      return {
        type: 'usage-updated',
        usageSeconds: nonNegativeNumber(usage.seconds, name, 'usage.seconds'),
        ...(contextWindow === undefined
          ? {}
          : {
              contextWindowRatio: ratio(
                contextWindow.usage_ratio,
                name,
                'context_window.usage_ratio',
              ),
            }),
      };
    }

    case 'session.delegation.created': {
      const delegation = requiredRecord(event.delegation, name);
      const target = requiredString(
        delegation.target,
        name,
        'delegation.target',
      );
      if (target !== 'responses') return { type: 'ignored', name };
      return {
        type: 'delegation-created',
        delegationId: requiredString(delegation.id, name, 'delegation.id'),
        responseId: requiredString(
          delegation.response_id,
          name,
          'delegation.response_id',
        ),
        offsetMs: nonNegativeNumber(event.offset_ms, name, 'offset_ms'),
      };
    }

    case 'response.event':
      return parseResponseEvent(event, name);

    default:
      return { type: 'ignored', name };
  }
}

function parseResponseEvent(
  outer: Record<string, unknown>,
  outerName: string,
): GPTLiveServerEvent {
  const delegationId = requiredString(
    outer.delegation_id,
    outerName,
    'delegation_id',
  );
  const event = requiredRecord(outer.event, outerName);
  const name = requiredString(event.type, outerName, 'event.type');

  if (name === 'response.created') {
    const response = requiredRecord(event.response, name);
    return {
      type: 'response-started',
      delegationId,
      responseId: requiredString(response.id, name, 'response.id'),
    };
  }

  if (name === 'response.output_item.done') {
    const item = requiredRecord(event.item, name);
    if (optionalString(item.type) !== 'function_call') {
      return { type: 'ignored', name: `${outerName}:${name}` };
    }
    return {
      type: 'response-function-call',
      delegationId,
      call: {
        ...withKey('itemId', optionalString(item.id)),
        callId: requiredString(item.call_id, name, 'item.call_id'),
        name: requiredString(item.name, name, 'item.name'),
        argumentsJson:
          item.arguments === undefined || item.arguments === ''
            ? '{}'
            : boundedString(
                item.arguments,
                name,
                'item.arguments',
                GPT_LIVE_MAX_FUNCTION_ARGUMENT_CHARACTERS,
              ),
      },
    };
  }

  if (name === 'response.completed' || name === 'response.failed') {
    const response = requiredRecord(event.response, name);
    const usage = optionalRecord(response.usage);
    return {
      type: 'response-terminal',
      delegationId,
      responseId: requiredString(response.id, name, 'response.id'),
      status: name === 'response.completed' ? 'completed' : 'failed',
      ...withKey(
        'inputTokens',
        optionalNonNegativeNumber(
          usage?.input_tokens,
          name,
          'usage.input_tokens',
        ),
      ),
      ...withKey(
        'outputTokens',
        optionalNonNegativeNumber(
          usage?.output_tokens,
          name,
          'usage.output_tokens',
        ),
      ),
    };
  }

  if (name === 'error') {
    const error = optionalRecord(event.error) ?? event;
    return {
      type: 'response-error',
      delegationId,
      ...withKey('code', truncate(errorField(error.code))),
      message: truncate(
        errorField(error.message) ?? 'GPT-Live delegated response failed',
      ),
    };
  }

  return { type: 'ignored', name: `${outerName}:${name}` };
}

const REDACTED_ERROR_FIELD =
  /secret|token|key|auth|password|cookie|credential|audio|delta|argument|content|transcript|instruction|text/i;

/**
 * A redacted copy of a raw provider error event, for logs. Returns undefined for
 * every other event, so callers can run it before typed parsing.
 */
export function providerErrorLogView(raw: unknown): unknown {
  const event = optionalRecord(raw);
  if (event === undefined) return undefined;
  if (event.type === 'error') return redactErrorValue(event);
  const inner = optionalRecord(event.event);
  if (event.type === 'response.event' && inner?.type === 'error')
    return redactErrorValue({
      type: event.type,
      delegation_id: event.delegation_id,
      event: inner,
    });
  return undefined;
}

function redactErrorValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, 500);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  )
    return value;
  if (depth >= 4) return '[MAX_DEPTH]';
  if (Array.isArray(value))
    return value.slice(0, 8).map((entry) => redactErrorValue(entry, depth + 1));
  const record = optionalRecord(value);
  if (record === undefined) return typeof value;
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 32)
      .map(([key, entry]) => [
        key,
        REDACTED_ERROR_FIELD.test(key)
          ? '[REDACTED]'
          : redactErrorValue(entry, depth + 1),
      ]),
  );
}

export function parseLiveEventJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new GPTLiveWireEventError('Live event is not valid JSON');
  }
}

function requiredRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  const record = optionalRecord(value);
  if (record === undefined)
    throw new GPTLiveWireEventError(`${context} is not an object`);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  value: unknown,
  eventType: string,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has a malformed ${field}`,
    );
  return value;
}

function boundedString(
  value: unknown,
  eventType: string,
  field: string,
  maxLength: number,
): string {
  const text = requiredString(value, eventType, field);
  if (text.length > maxLength)
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has an oversized ${field}`,
    );
  return text;
}

function requiredBase64(
  value: unknown,
  eventType: string,
  field: string,
  maxLength: number,
): string {
  const encoded = requiredString(value, eventType, field);
  if (encoded.length > maxLength)
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has oversized base64 ${field}`,
    );
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    ) ||
    Buffer.from(encoded, 'base64').toString('base64') !== encoded
  )
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has malformed base64 ${field}`,
    );
  return encoded;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads a string, number or nested `{ code | type | message }` error field. */
function errorField(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  const record = optionalRecord(value);
  if (record === undefined || depth >= 2) return undefined;
  return (
    errorField(record.code, depth + 1) ??
    errorField(record.type, depth + 1) ??
    errorField(record.message, depth + 1)
  );
}

function nonNegativeNumber(
  value: unknown,
  eventType: string,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has a malformed ${field}`,
    );
  return value;
}

function optionalNonNegativeNumber(
  value: unknown,
  eventType: string,
  field: string,
): number | undefined {
  return value === undefined
    ? undefined
    : nonNegativeNumber(value, eventType, field);
}

function ratio(value: unknown, eventType: string, field: string): number {
  const result = nonNegativeNumber(value, eventType, field);
  if (result > 1)
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has a malformed ${field}`,
    );
  return result;
}

function closeReason(
  value: unknown,
  eventType: string,
):
  | 'close_requested'
  | 'expired'
  | 'content'
  | 'remote_hangup'
  | 'connection_lost' {
  if (
    value !== 'close_requested' &&
    value !== 'expired' &&
    value !== 'content' &&
    value !== 'remote_hangup' &&
    value !== 'connection_lost'
  ) {
    throw new GPTLiveWireEventError(
      `Live event ${eventType} has a malformed reason`,
    );
  }
  return value;
}

function truncate(value: string): string;
function truncate(value: string | undefined): string | undefined;
function truncate(value: string | undefined): string | undefined {
  return value?.slice(0, 1_000);
}

function withKey<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
