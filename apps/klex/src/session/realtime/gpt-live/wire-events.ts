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
  const parsed = parseRaw(raw);
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

    case 'error': {
      const error = requiredRecord(event.error, name);
      return {
        type: 'provider-error',
        error: {
          type: truncate(requiredString(error.type, name, 'error.type')),
          code: truncate(requiredString(error.code, name, 'error.code')),
          message: truncate(
            requiredString(error.message, name, 'error.message'),
          ),
          ...withKey('param', truncate(optionalString(error.param))),
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
        delta: requiredString(event.delta, name, 'delta'),
        startMs,
        endMs,
      };
    }

    case 'session.output_audio.delta':
      return {
        type: 'output-audio-delta',
        delta: requiredString(event.delta, name, 'delta'),
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
        argumentsJson: requiredString(item.arguments, name, 'item.arguments'),
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
    return {
      type: 'response-error',
      delegationId,
      ...withKey('code', truncate(optionalString(event.code))),
      message: truncate(requiredString(event.message, name, 'message')),
    };
  }

  return { type: 'ignored', name: `${outerName}:${name}` };
}

function parseRaw(raw: unknown): unknown {
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
