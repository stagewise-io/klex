/**
 * Strict runtime parsing for the OpenAI Realtime server events this
 * adapter consumes.
 *
 * Everything the adapter acts on is validated here, so the session logic
 * never inspects untyped provider payloads and never needs an unchecked
 * cast. Events the adapter does not consume are reported as `ignored`
 * instead of failing the call — the provider is free to add events.
 */

export interface OpenAIProviderErrorDetails {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
  readonly param?: string;
}

export type OpenAIServerEvent =
  | { readonly type: 'session-updated' }
  | {
      readonly type: 'provider-error';
      readonly eventId?: string;
      readonly error: OpenAIProviderErrorDetails;
    }
  | { readonly type: 'response-created'; readonly responseId?: string }
  | { readonly type: 'response-done'; readonly responseId?: string }
  | {
      readonly type: 'output-audio-delta';
      readonly responseId?: string;
      readonly itemId?: string;
      readonly delta: string;
    }
  | { readonly type: 'speech-started' }
  | {
      readonly type: 'input-transcript-done';
      readonly eventId: string;
      readonly itemId: string;
      readonly transcript: string;
    }
  | {
      readonly type: 'output-transcript-done';
      readonly eventId: string;
      readonly responseId?: string;
      readonly itemId?: string;
      readonly transcript: string;
    }
  | {
      readonly type: 'function-call-started';
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: 'function-call-arguments-done';
      readonly eventId: string;
      readonly callId: string;
      readonly name?: string;
      readonly argumentsJson: string;
    }
  | { readonly type: 'ignored'; readonly name: string };

/** Thrown when a consumed event is missing or misshapes required fields. */
export class OpenAIWireEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIWireEventError';
    Object.setPrototypeOf(this, OpenAIWireEventError.prototype);
  }
}

export function parseServerEvent(raw: string): OpenAIServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenAIWireEventError('OpenAI realtime event is not valid JSON');
  }
  const event = asRecord(parsed);
  if (!event)
    throw new OpenAIWireEventError('OpenAI realtime event is not an object');
  const name = optionalString(event.type);
  if (name === undefined)
    throw new OpenAIWireEventError('OpenAI realtime event has no type');

  switch (name) {
    case 'session.updated':
      return { type: 'session-updated' };

    case 'error': {
      const details = asRecord(event.error) ?? {};
      return {
        type: 'provider-error',
        ...(optionalString(event.event_id) !== undefined && {
          eventId: truncate(optionalString(event.event_id)),
        }),
        error: {
          ...withKey('type', truncate(optionalString(details.type))),
          ...withKey('code', truncate(optionalString(details.code))),
          ...withKey('message', truncate(optionalString(details.message))),
          ...withKey('param', truncate(optionalString(details.param))),
        },
      };
    }

    case 'response.created':
    case 'response.done': {
      const response = asRecord(event.response);
      const responseId = optionalString(response?.id);
      return {
        type:
          name === 'response.created' ? 'response-created' : 'response-done',
        ...withKey('responseId', responseId),
      };
    }

    case 'response.output_audio.delta':
      return {
        type: 'output-audio-delta',
        ...withKey('responseId', optionalString(event.response_id)),
        ...withKey('itemId', optionalString(event.item_id)),
        delta: requiredString(event.delta, name, 'delta'),
      };

    case 'input_audio_buffer.speech_started':
      return { type: 'speech-started' };

    case 'conversation.item.input_audio_transcription.completed': {
      const itemId = requiredString(event.item_id, name, 'item_id');
      return {
        type: 'input-transcript-done',
        eventId: optionalString(event.event_id) ?? itemId,
        itemId,
        transcript: requiredString(event.transcript, name, 'transcript'),
      };
    }

    case 'response.output_audio_transcript.done': {
      const itemId = optionalString(event.item_id);
      return {
        type: 'output-transcript-done',
        eventId: optionalString(event.event_id) ?? itemId ?? name,
        ...withKey('responseId', optionalString(event.response_id)),
        ...withKey('itemId', itemId),
        transcript: requiredString(event.transcript, name, 'transcript'),
      };
    }

    case 'response.output_item.added': {
      const item = asRecord(event.item);
      if (!item || optionalString(item.type) !== 'function_call')
        return { type: 'ignored', name };
      return {
        type: 'function-call-started',
        callId: requiredString(item.call_id, name, 'item.call_id'),
        name: requiredString(item.name, name, 'item.name'),
      };
    }

    case 'response.function_call_arguments.done': {
      const callId = requiredString(event.call_id, name, 'call_id');
      return {
        type: 'function-call-arguments-done',
        eventId: optionalString(event.event_id) ?? callId,
        callId,
        ...withKey('name', optionalString(event.name)),
        argumentsJson: requiredString(event.arguments, name, 'arguments'),
      };
    }

    default:
      return { type: 'ignored', name };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(
  value: unknown,
  eventType: string,
  field: string,
): string {
  if (typeof value !== 'string')
    throw new OpenAIWireEventError(
      `OpenAI realtime event ${eventType} has a malformed ${field}`,
    );
  return value;
}

function truncate(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, 1_000);
}

function withKey<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
