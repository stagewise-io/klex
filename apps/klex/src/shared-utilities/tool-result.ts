import type { ToolResultPart } from 'ai';

const KNOWN_MEDIA_TYPES = new Set([
  'audio',
  'image',
  'image-data',
  'image-url',
  'image-file-id',
  'file',
  'file-data',
  'file-url',
  'file-id',
  'media',
]);
const TEXT_KEYS = new Set([
  'type',
  'text',
  'annotations',
  '_meta',
  'providerMetadata',
  'providerOptions',
]);

function isContentBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  if (part.type === 'resource_link') return typeof part.uri === 'string';
  if (part.type === 'resource') {
    const resource = part.resource;
    return (
      resource !== null &&
      typeof resource === 'object' &&
      'uri' in resource &&
      typeof resource.uri === 'string'
    );
  }
  if (part.type === 'text')
    return (
      typeof part.text === 'string' &&
      Reflect.ownKeys(part).every(
        (key) => typeof key === 'string' && TEXT_KEYS.has(key),
      )
    );
  return (
    typeof part.type === 'string' &&
    KNOWN_MEDIA_TYPES.has(part.type) &&
    (typeof part.data === 'string' ||
      part.data instanceof Uint8Array ||
      part.data instanceof URL ||
      typeof part.url === 'string' ||
      part.url instanceof URL ||
      typeof part.fileId === 'string' ||
      typeof part.mediaType === 'string' ||
      typeof part.mimeType === 'string')
  );
}

function envelopeContent(value: object): unknown[] | null {
  const envelope = value as Record<string, unknown>;
  if (
    !Reflect.ownKeys(envelope).every(
      (key) =>
        key === 'content' ||
        (key === 'structuredContent' &&
          envelope.structuredContent !== null &&
          typeof envelope.structuredContent === 'object' &&
          !Array.isArray(envelope.structuredContent)) ||
        (key === 'isError' && typeof envelope.isError === 'boolean') ||
        (key === '_meta' &&
          envelope._meta !== null &&
          typeof envelope._meta === 'object'),
    )
  )
    return null;
  if (
    !Array.isArray(envelope.content) ||
    !envelope.content.every(isContentBlock)
  )
    return null;
  // Preserve structured-only results through the caller's JSON fallback.
  if (
    envelope.structuredContent !== undefined &&
    envelope.content.every((part) => part.type === 'text' && part.text === '')
  )
    return null;
  // Structured content and metadata may duplicate media payloads or signed URLs.
  // Only the recognized content blocks are projected into transcript text.
  return envelope.content;
}

/** Describe media without copying binary payloads or URLs into text prompts. */
export function describeMediaContent(part: {
  type: string;
  mediaType?: string;
  mimeType?: string;
  filename?: string;
  url?: string;
}): string {
  const mediaType = part.mediaType ?? part.mimeType;
  const kind = mediaType?.startsWith('audio/')
    ? 'Audio'
    : mediaType?.startsWith('image/') || part.type.startsWith('image')
      ? 'Image'
      : part.type.startsWith('file')
        ? 'File'
        : 'Media';
  return `[${kind} attachment: ${mediaType ?? part.type}]`;
}

/** Text projection of SDK or MCP content outputs, before any truncation. */
export function extractContentOutputText(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  // JSON tool results can wrap the same MCP content array. Unwrap only
  // this envelope; ordinary JSON results retain their existing serialization.
  if (
    'type' in output &&
    (output.type === 'json' || output.type === 'error-json') &&
    'value' in output &&
    output.value &&
    typeof output.value === 'object' &&
    'content' in output.value
  ) {
    return extractContentOutputText(output.value);
  }
  const value =
    'type' in output && output.type === 'content' && 'value' in output
      ? output.value
      : envelopeContent(output);
  if (!Array.isArray(value)) return null;
  return value
    .map((part: unknown) => {
      if (
        !part ||
        typeof part !== 'object' ||
        !('type' in part) ||
        typeof part.type !== 'string'
      ) {
        return '[Unknown content]';
      }
      if (
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      )
        return part.text;
      const field = (key: string): string | undefined => {
        const source =
          part.type === 'resource' &&
          'resource' in part &&
          part.resource !== null &&
          typeof part.resource === 'object'
            ? part.resource
            : part;
        const value = (source as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
      };
      return describeMediaContent({
        type: part.type,
        mediaType: field('mediaType'),
        mimeType: field('mimeType'),
      });
    })
    .join('\n');
}

/** Extracts a text string from a ToolResultPart's output field. */
export function extractToolResultText(part: ToolResultPart): string {
  const output = part.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const content = extractContentOutputText(output);
    if (content !== null) return content;
    if (output.type === 'text') return output.value as string;
    if (output.type === 'error-text') return output.value as string;
    if (output.type === 'json' || output.type === 'error-json') {
      return JSON.stringify(output.value);
    }
  }
  return '';
}
