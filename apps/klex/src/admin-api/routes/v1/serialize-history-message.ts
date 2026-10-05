import type { ExtendedUIMessage } from '@/session/chat/message-types';

/**
 * A persisted message part in AI SDK `UIMessage` shape. Part types are open
 * (`tool-${name}`, `data-${name}`), so fields are not modeled per type.
 */
export type HistoryMessagePart = {
  type: string;
  [key: string]: unknown;
};

export interface HistoryMessage {
  id: string;
  role: ExtendedUIMessage['role'];
  metadata?: unknown;
  parts: HistoryMessagePart[];
}

export interface SerializeHistoryMessageOptions {
  /**
   * Keep provider-specific part metadata (`providerMetadata`,
   * `callProviderMetadata`, `resultProviderMetadata`). It holds opaque
   * values such as encrypted reasoning that are only useful to replay a
   * session against the same provider.
   */
  includeProviderMetadata: boolean;
}

const PROVIDER_METADATA_KEYS = new Set([
  'providerMetadata',
  'callProviderMetadata',
  'resultProviderMetadata',
]);

/** Content block types that carry inline base64 in a `data` field. */
const BASE64_BLOCK_TYPES = new Set([
  // MCP content blocks
  'image',
  'audio',
  // AI SDK tool result content
  'media',
  'image-data',
  'file-data',
]);

/**
 * A string that is itself a `data:` URL, in any encoding. The header may
 * not contain whitespace, so prose starting with "data: " is not matched.
 * Headers (media type and parameters) are capped at 256 characters.
 */
const WHOLE_DATA_URL = /^data:[^\s,]{0,256},/i;

/**
 * A `data:` URL inside free-form text. The payload ends at whitespace, a
 * quote, or a closing bracket; the lookbehind skips words like `metadata:`.
 * The bounded header keeps each failed candidate O(1), so text with many
 * `data:` prefixes and no comma is scanned in linear time.
 */
const EMBEDDED_DATA_URL =
  /(?<![\w-])(data:[^\s,"'<>]{0,256},)([^\s"'<>)\]]+)/gi;

/** Guards against pathological nesting in persisted tool payloads. */
const MAX_DEPTH = 64;

const MAX_DEPTH_PLACEHOLDER = '[redacted, maximum depth exceeded]';

function redacted(length: number): string {
  return `[redacted, ${length} bytes]`;
}

function redactString(value: string): string {
  const whole = WHOLE_DATA_URL.exec(value);
  if (whole) {
    return `${whole[0]}${redacted(value.length - whole[0].length)}`;
  }
  if (!/data:/i.test(value)) return value;
  return value.replace(
    EMBEDDED_DATA_URL,
    (_match, header: string, payload: string) =>
      `${header}${redacted(payload.length)}`,
  );
}

/**
 * Defines an own enumerable property. Plain assignment of a stored own
 * `__proto__` key would invoke the prototype setter and drop the field.
 */
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `value` with inline binary payloads replaced by a
 * `[redacted, N bytes]` placeholder: `data:` URL payloads, the `data` field
 * of image/audio/media blocks, and MCP embedded resource `blob`s. Subtrees
 * beyond `MAX_DEPTH` are replaced entirely, never passed through.
 */
function redactBinary(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return MAX_DEPTH_PLACEHOLDER;
  if (Array.isArray(value)) {
    return value.map((item) => redactBinary(item, depth + 1));
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  const isBase64Block =
    typeof value.type === 'string' && BASE64_BLOCK_TYPES.has(value.type);
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string' &&
      ((key === 'data' && isBase64Block) || key === 'blob')
    ) {
      setOwn(result, key, redacted(entry.length));
    } else {
      setOwn(result, key, redactBinary(entry, depth + 1));
    }
  }
  return result;
}

function serializePart(
  part: ExtendedUIMessage['parts'][number],
  options: SerializeHistoryMessageOptions,
): HistoryMessagePart {
  const result: HistoryMessagePart = { type: part.type };
  for (const [key, value] of Object.entries(part)) {
    if (key === 'type') continue;
    if (PROVIDER_METADATA_KEYS.has(key)) {
      // Opaque provider values are passed through untouched when requested.
      if (options.includeProviderMetadata) setOwn(result, key, value);
      continue;
    }
    setOwn(result, key, redactBinary(value));
  }
  return result;
}

/**
 * Serializes a persisted message for the session history API. Unlike the
 * God Messages preview serializer, this keeps the stored AI SDK shape and
 * full tool inputs/outputs; only inline binary data is redacted and
 * provider metadata is opt-in.
 */
export function serializeHistoryMessage(
  message: ExtendedUIMessage,
  options: SerializeHistoryMessageOptions,
): HistoryMessage {
  const { metadata } = message;
  return {
    id: message.id,
    role: message.role,
    ...(metadata === undefined ? {} : { metadata: redactBinary(metadata) }),
    parts: message.parts.map((part) => serializePart(part, options)),
  };
}
