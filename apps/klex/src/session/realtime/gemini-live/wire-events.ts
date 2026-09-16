export const GEMINI_MAX_AUDIO_BYTES = 192_000;
export const GEMINI_MAX_TEXT_CHARACTERS = 65_536;
const MAX_BASE64_CHARACTERS = Math.ceil(GEMINI_MAX_AUDIO_BYTES / 3) * 4;

export type GeminiServerEvent =
  | { readonly type: 'setup-complete' }
  | {
      readonly type: 'server-content';
      readonly audio: readonly string[];
      readonly text: readonly string[];
      readonly inputTranscript?: string;
      readonly outputTranscript?: string;
      readonly interrupted: boolean;
      readonly turnComplete: boolean;
      readonly interactionStatus?: 'IN_PROGRESS' | 'IDLE';
    }
  | {
      readonly type: 'tool-call';
      readonly calls: readonly {
        readonly id: string;
        readonly name: string;
        readonly args: unknown;
      }[];
    }
  | { readonly type: 'tool-call-cancellation'; readonly ids: readonly string[] }
  | {
      readonly type: 'resumption-update';
      readonly handle?: string;
      readonly resumable: boolean;
    }
  | { readonly type: 'go-away'; readonly timeLeft?: string }
  | {
      readonly type: 'provider-error';
      readonly message: string;
      readonly code?: number;
    }
  | { readonly type: 'ignored'; readonly name: string };

export class GeminiWireEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiWireEventError';
    Object.setPrototypeOf(this, GeminiWireEventError.prototype);
  }
}

export function parseGeminiServerEvent(raw: string): GeminiServerEvent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GeminiWireEventError('Gemini Live event is not valid JSON');
  }
  const event = record(value, 'Gemini Live event');
  if ('setupComplete' in event) return { type: 'setup-complete' };
  if ('serverContent' in event) return parseServerContent(event.serverContent);
  if ('toolCall' in event) return parseToolCall(event.toolCall);
  if ('toolCallCancellation' in event)
    return {
      type: 'tool-call-cancellation',
      ids: stringArray(
        record(event.toolCallCancellation, 'toolCallCancellation').ids,
        'toolCallCancellation.ids',
      ),
    };
  if ('sessionResumptionUpdate' in event) {
    const update = record(
      event.sessionResumptionUpdate,
      'sessionResumptionUpdate',
    );
    return {
      type: 'resumption-update',
      ...optionalKey('handle', optionalString(update.newHandle)),
      resumable: update.resumable === true,
    };
  }
  if ('goAway' in event) {
    const goAway = record(event.goAway, 'goAway');
    return {
      type: 'go-away',
      ...optionalKey('timeLeft', optionalString(goAway.timeLeft)),
    };
  }
  if ('error' in event) {
    const error = record(event.error, 'error');
    return {
      type: 'provider-error',
      message: boundedString(error.message, 'error.message'),
      ...(typeof error.code === 'number' && { code: error.code }),
    };
  }
  if ('usageMetadata' in event)
    return { type: 'ignored', name: 'usageMetadata' };
  return { type: 'ignored', name: Object.keys(event)[0] ?? 'unknown' };
}

function parseServerContent(value: unknown): GeminiServerEvent {
  const content = record(value, 'serverContent');
  const audio: string[] = [];
  const text: string[] = [];
  const modelTurn = optionalRecord(content.modelTurn);
  const parts = modelTurn?.parts;
  if (parts !== undefined) {
    if (!Array.isArray(parts))
      throw new GeminiWireEventError(
        'serverContent.modelTurn.parts is not an array',
      );
    for (const [index, partValue] of parts.entries()) {
      const part = record(partValue, `serverContent.modelTurn.parts[${index}]`);
      if (part.text !== undefined)
        text.push(
          boundedString(
            part.text,
            `serverContent.modelTurn.parts[${index}].text`,
          ),
        );
      const inlineData = optionalRecord(part.inlineData);
      if (inlineData?.data !== undefined) {
        const mimeType = optionalString(inlineData.mimeType);
        if (mimeType?.startsWith('audio/pcm'))
          audio.push(
            base64(
              inlineData.data,
              `serverContent.modelTurn.parts[${index}].inlineData.data`,
            ),
          );
      }
    }
  }
  const input = optionalRecord(content.inputTranscription);
  const output = optionalRecord(content.outputTranscription);
  const status = optionalString(content.interactionStatus);
  if (status !== undefined && status !== 'IN_PROGRESS' && status !== 'IDLE')
    throw new GeminiWireEventError(
      'serverContent.interactionStatus is invalid',
    );
  return {
    type: 'server-content',
    audio,
    text,
    ...optionalKey(
      'inputTranscript',
      input?.text === undefined
        ? undefined
        : boundedString(input.text, 'inputTranscription.text'),
    ),
    ...optionalKey(
      'outputTranscript',
      output?.text === undefined
        ? undefined
        : boundedString(output.text, 'outputTranscription.text'),
    ),
    interrupted: content.interrupted === true,
    turnComplete: content.turnComplete === true,
    ...(status !== undefined && { interactionStatus: status }),
  };
}

function parseToolCall(value: unknown): GeminiServerEvent {
  const payload = record(value, 'toolCall');
  if (!Array.isArray(payload.functionCalls))
    throw new GeminiWireEventError('toolCall.functionCalls is not an array');
  return {
    type: 'tool-call',
    calls: payload.functionCalls.map((value, index) => {
      const call = record(value, `toolCall.functionCalls[${index}]`);
      return {
        id: boundedString(
          call.id,
          `toolCall.functionCalls[${index}].id`,
          1_024,
        ),
        name: boundedString(
          call.name,
          `toolCall.functionCalls[${index}].name`,
          1_024,
        ),
        args: call.args ?? {},
      };
    }),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new GeminiWireEventError(`${name} is not an object`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return record(value, 'value');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.slice(0, GEMINI_MAX_TEXT_CHARACTERS)
    : undefined;
}

function boundedString(
  value: unknown,
  name: string,
  maximum = GEMINI_MAX_TEXT_CHARACTERS,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw new GeminiWireEventError(`${name} is not a bounded non-empty string`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value))
    throw new GeminiWireEventError(`${name} is not an array`);
  return value.map((item, index) =>
    boundedString(item, `${name}[${index}]`, 1_024),
  );
}

function base64(value: unknown, name: string): string {
  const encoded = boundedString(value, name, MAX_BASE64_CHARACTERS);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new GeminiWireEventError(`${name} is not valid base64`);
  return encoded;
}

function optionalKey<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}
