import { getToolName, isToolUIPart } from 'ai';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

/**
 * JSON-safe representation of a single UI message part.
 * The `type` field is always present; other fields vary by part type.
 */
export type SerializedPart = {
  type: string;
  [key: string]: unknown;
};

/**
 * JSON-safe representation of a UI message.
 */
export type SerializedMessage = {
  id: string;
  role: string;
  parts: SerializedPart[];
};

/**
 * Maximum length for truncated JSON strings (tool args, results).
 */
const MAX_JSON_LENGTH = 100;

/**
 * Redacts base64 data in a content block by replacing the `data` field
 * with a `[redacted, N bytes]` placeholder.
 */
function redactContentBlocks(
  content: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return content.map((block) => {
    if (block.type === 'image' || block.type === 'audio') {
      const data = block.data;
      if (typeof data === 'string') {
        return {
          ...block,
          data: `[redacted, ${data.length} bytes]`,
        };
      }
    }
    if (block.type === 'resource') {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (resource?.blob !== undefined && typeof resource.blob === 'string') {
        return {
          ...block,
          resource: {
            ...resource,
            blob: `[redacted, ${resource.blob.length} bytes]`,
          },
        };
      }
    }
    return block;
  });
}

function serializeBoundedJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_JSON_LENGTH
      ? `${json.slice(0, MAX_JSON_LENGTH)}...`
      : JSON.parse(json);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Serializes a single UI message part into a JSON-safe representation.
 * Base64 data in image/audio/file parts is redacted.
 */
function serializePart(
  part: ExtendedUIMessage['parts'][number],
): SerializedPart {
  // Text parts — pass through directly.
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }

  // Reasoning parts — pass through directly.
  if (part.type === 'reasoning') {
    const reasoning = part as { type: 'reasoning'; text?: string };
    return { type: 'reasoning', text: reasoning.text ?? '' };
  }

  // Runtime tools use AI SDK dynamic `tool-${name}` UI parts. Normalize them
  // to a stable transport shape so the admin API and TUI do not depend on
  // dynamically generated part type names.
  if (isToolUIPart(part)) {
    const result =
      part.state === 'output-error'
        ? { error: part.errorText ?? 'unknown error' }
        : part.state === 'output-denied'
          ? { denied: true }
          : 'output' in part
            ? serializeBoundedJson(part.output)
            : undefined;
    return {
      type: 'tool-invocation',
      toolCallId: part.toolCallId,
      toolName: getToolName(part),
      state: part.state,
      args: 'input' in part ? serializeBoundedJson(part.input) : undefined,
      result,
    };
  }

  // File parts — redact url/data.
  if (part.type === 'file') {
    const file = part as {
      type: 'file';
      mediaType: string;
      url?: string;
      data?: unknown;
    };
    return {
      type: 'file',
      mediaType: file.mediaType,
    };
  }

  // Custom data parts — data-context, data-god-message, data-continue, data-check.
  if (
    part.type === 'data-context' ||
    part.type === 'data-god-message' ||
    part.type === 'data-continue' ||
    part.type === 'data-check'
  ) {
    const dataPart = part as {
      type: string;
      data: Record<string, unknown>;
    };
    const serializedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dataPart.data)) {
      if (key === 'content' && Array.isArray(value)) {
        serializedData[key] = redactContentBlocks(
          value as Array<Record<string, unknown>>,
        );
      } else {
        serializedData[key] = value;
      }
    }
    return { type: part.type, data: serializedData };
  }

  // Fallback for unknown part types — preserve type only.
  return { type: part.type };
}

/**
 * Converts an array of `ExtendedUIMessage` into JSON-safe `SerializedMessage[]`.
 * Base64 data in image/audio/file parts is redacted.
 */
export function serializeMessages(
  messages: readonly ExtendedUIMessage[],
): SerializedMessage[] {
  return messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    parts: msg.parts.map(serializePart),
  }));
}
