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

const DATA_URL_PATTERN = /^data:([^;,]*)(?:;[^,]*)?;base64,/i;

/** Guards against pathological nesting in persisted tool payloads. */
const MAX_DEPTH = 64;

function redacted(length: number): string {
  return `[redacted, ${length} bytes]`;
}

function redactString(value: string): string {
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return value;
  const payloadLength = value.length - match[0].length;
  return `${match[0]}${redacted(payloadLength)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `value` with inline binary payloads replaced by a
 * `[redacted, N bytes]` placeholder: `data:` URLs, the `data` field of
 * image/audio/media blocks, and MCP embedded resource `blob`s.
 */
function redactBinary(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (depth >= MAX_DEPTH) return value;
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
      result[key] = redacted(entry.length);
    } else {
      result[key] = redactBinary(entry, depth + 1);
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
      if (options.includeProviderMetadata) result[key] = value;
      continue;
    }
    result[key] = redactBinary(value);
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
