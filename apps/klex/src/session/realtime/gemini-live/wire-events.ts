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
  | {
      readonly type: 'session-resumption-update';
      readonly resumable: boolean;
      readonly newHandle?: string;
    }
  | {
      readonly type: 'go-away';
      /** Absent when the server omitted or malformed `timeLeft`. */
      readonly timeLeftMs?: number;
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

  if (root.sessionResumptionUpdate !== undefined) {
    const update = asRecord(root.sessionResumptionUpdate) ?? {};
    const newHandle =
      typeof update.newHandle === 'string' && update.newHandle.length > 0
        ? update.newHandle
        : undefined;
    events.push({
      type: 'session-resumption-update',
      resumable: update.resumable === true && newHandle !== undefined,
      ...(newHandle !== undefined && { newHandle }),
    });
  }

  if (root.goAway !== undefined) {
    const goAway = asRecord(root.goAway) ?? {};
    const timeLeftMs = parseDurationMs(goAway.timeLeft);
    events.push({
      type: 'go-away',
      ...(timeLeftMs !== undefined && { timeLeftMs }),
    });
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

/**
 * Reads a protobuf `Duration`: the JSON mapping is a decimal-seconds string
 * such as `"12.5s"`, but some encoders emit `{ seconds, nanos }`.
 */
export function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
    return match ? finiteMs(Number(match[1]) * 1_000) : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const seconds = durationField(record.seconds);
  const nanos = durationField(record.nanos);
  if (seconds === undefined || nanos === undefined) return undefined;
  return finiteMs(seconds * 1_000 + nanos / 1_000_000);
}

/** An absent field is zero; anything but a non-negative number is malformed. */
function durationField(value: unknown): number | undefined {
  if (value === undefined) return 0;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function finiteMs(value: number): number | undefined {
  return Number.isFinite(value) ? Math.round(value) : undefined;
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
