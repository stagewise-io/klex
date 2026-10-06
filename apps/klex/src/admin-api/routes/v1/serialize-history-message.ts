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
 * Anchored at the start, so a single linear attempt.
 */
const WHOLE_DATA_URL = /^data:[^\s,]*,/i;

/** Literal search for `data:` candidates inside free-form text. */
const DATA_PREFIX = /data:/gi;
const DATA_PREFIX_LENGTH = 'data:'.length;

/** Preceding character that marks a word like `metadata:`, not a URL. */
const WORD_CHAR = /[\w-]/;

/** Characters that end an embedded header (in addition to the comma). */
const HEADER_END = /[\s"'<>]/;

/** Characters that end an embedded payload. */
const PAYLOAD_END = /[\s"'<>)\]]/;

/** Guards against pathological nesting in persisted tool payloads. */
const MAX_DEPTH = 64;

const MAX_DEPTH_PLACEHOLDER = '[redacted, maximum depth exceeded]';

function redacted(length: number): string {
  return `[redacted, ${length} bytes]`;
}

/**
 * Redacts `data:` URLs embedded in free-form text. Headers have no length
 * limit. A candidate whose header ends without a comma advances the scan to
 * that header end: every later candidate inside the span would stop at the
 * same character and fail too, so the whole pass stays linear.
 */
function redactEmbedded(value: string): string {
  const length = value.length;
  let output = '';
  let copied = 0;
  DATA_PREFIX.lastIndex = 0;
  for (
    let match = DATA_PREFIX.exec(value);
    match !== null;
    match = DATA_PREFIX.exec(value)
  ) {
    const start = match.index;
    if (start > 0 && WORD_CHAR.test(value.charAt(start - 1))) continue;

    let comma = start + DATA_PREFIX_LENGTH;
    while (
      comma < length &&
      value.charAt(comma) !== ',' &&
      !HEADER_END.test(value.charAt(comma))
    ) {
      comma++;
    }
    if (value.charAt(comma) !== ',') {
      DATA_PREFIX.lastIndex = comma;
      continue;
    }

    let end = comma + 1;
    while (end < length && !PAYLOAD_END.test(value.charAt(end))) end++;
    DATA_PREFIX.lastIndex = end;
    if (end === comma + 1) continue;

    output += `${value.slice(copied, comma + 1)}${redacted(end - comma - 1)}`;
    copied = end;
  }
  return copied === 0 ? value : `${output}${value.slice(copied)}`;
}

function redactString(value: string): string {
  const whole = WHOLE_DATA_URL.exec(value);
  if (whole) {
    return `${whole[0]}${redacted(value.length - whole[0].length)}`;
  }
  return redactEmbedded(value);
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
