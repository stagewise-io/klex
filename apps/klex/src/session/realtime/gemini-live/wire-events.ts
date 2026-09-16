/**
 * Strict runtime parsing for Google Gemini Live (BidiGenerateContent) WebSocket server events.
 */

export interface GeminiProviderErrorDetails {
  readonly code?: string;
  readonly message?: string;
  readonly status?: string;
}

export interface GeminiFunctionCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type GeminiLiveServerEvent =
  | { readonly type: 'setup-complete' }
  | {
      readonly type: 'provider-error';
      readonly error: GeminiProviderErrorDetails;
    }
  | {
      readonly type: 'output-audio-delta';
      readonly delta: string;
    }
  | {
      readonly type: 'output-transcript';
      readonly transcript: string;
    }
  | {
      readonly type: 'input-transcript';
      readonly transcript: string;
    }
  | {
      readonly type: 'interrupted';
    }
  | {
      readonly type: 'turn-complete';
    }
  | {
      readonly type: 'tool-call';
      readonly calls: readonly GeminiFunctionCall[];
    }
  | {
      readonly type: 'tool-call-cancellation';
      readonly ids: readonly string[];
    }
  | { readonly type: 'ignored'; readonly rawType?: string };

export class GeminiLiveWireEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiLiveWireEventError';
    Object.setPrototypeOf(this, GeminiLiveWireEventError.prototype);
  }
}

export function parseGeminiLiveServerEvents(
  raw: string,
): GeminiLiveServerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GeminiLiveWireEventError('Gemini live event is not valid JSON');
  }
  const root = asRecord(parsed);
  if (!root)
    throw new GeminiLiveWireEventError('Gemini live event is not an object');

  const events: GeminiLiveServerEvent[] = [];

  if (root.setupComplete !== undefined) {
    events.push({ type: 'setup-complete' });
  }

  if (root.error !== undefined) {
    const errorRecord = asRecord(root.error) ?? {};
    events.push({
      type: 'provider-error',
      error: {
        code: optionalString(
          errorRecord.code ??
            (typeof errorRecord.code === 'number'
              ? String(errorRecord.code)
              : undefined),
        ),
        message: optionalString(errorRecord.message),
        status: optionalString(errorRecord.status),
      },
    });
  }

  if (root.serverContent !== undefined) {
    const serverContent = asRecord(root.serverContent) ?? {};

    if (serverContent.interrupted === true) {
      events.push({ type: 'interrupted' });
    }

    const inputTranscription = asRecord(serverContent.inputTranscription);
    if (
      typeof inputTranscription?.text === 'string' &&
      inputTranscription.text.length > 0
    ) {
      events.push({
        type: 'input-transcript',
        transcript: inputTranscription.text,
      });
    }

    const outputTranscription = asRecord(serverContent.outputTranscription);
    if (
      typeof outputTranscription?.text === 'string' &&
      outputTranscription.text.length > 0
    ) {
      events.push({
        type: 'output-transcript',
        transcript: outputTranscription.text,
      });
    }

    const modelTurn = asRecord(serverContent.modelTurn);
    if (modelTurn && Array.isArray(modelTurn.parts)) {
      for (const part of modelTurn.parts) {
        const partRecord = asRecord(part);
        if (!partRecord) continue;

        const inlineData = asRecord(partRecord.inlineData);
        if (
          typeof inlineData?.data === 'string' &&
          inlineData.data.length > 0
        ) {
          events.push({
            type: 'output-audio-delta',
            delta: inlineData.data,
          });
        }

        if (typeof partRecord.text === 'string' && partRecord.text.length > 0) {
          events.push({
            type: 'output-transcript',
            transcript: partRecord.text,
          });
        }
      }
    }

    if (serverContent.turnComplete === true) {
      events.push({ type: 'turn-complete' });
    }
  }

  if (root.toolCall !== undefined) {
    const toolCall = asRecord(root.toolCall);
    if (toolCall && Array.isArray(toolCall.functionCalls)) {
      const calls: GeminiFunctionCall[] = [];
      for (const fc of toolCall.functionCalls) {
        const fcRecord = asRecord(fc);
        if (!fcRecord) continue;
        const name = requiredString(
          fcRecord.name,
          'toolCall.functionCalls',
          'name',
        );
        const callId = typeof fcRecord.id === 'string' ? fcRecord.id : name;
        const args = (asRecord(fcRecord.args) ?? {}) as Record<string, unknown>;
        calls.push({ callId, name, args });
      }
      if (calls.length > 0) {
        events.push({ type: 'tool-call', calls });
      }
    }
  }

  if (root.toolCallCancellation !== undefined) {
    const cancel = asRecord(root.toolCallCancellation);
    if (cancel && Array.isArray(cancel.ids)) {
      const ids = cancel.ids.filter(
        (id): id is string => typeof id === 'string',
      );
      events.push({ type: 'tool-call-cancellation', ids });
    }
  }

  if (events.length === 0) {
    return [{ type: 'ignored' }];
  }

  return events;
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
    throw new GeminiLiveWireEventError(
      `Gemini live event ${eventType} has a malformed ${field}`,
    );
  return value;
}
