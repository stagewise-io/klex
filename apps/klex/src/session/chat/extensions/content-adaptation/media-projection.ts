import type { FilePart, ImagePart, ModelMessage } from 'ai';

/** Normalize SDK/MCP tool media into ordinary input parts without serializing payloads. */
export function projectToolMedia(value: unknown): FilePart | ImagePart | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'image-url' && typeof item.url === 'string') {
    try {
      return { type: 'image', image: new URL(item.url) };
    } catch {
      return null;
    }
  }
  const mediaType = item.mediaType ?? item.mimeType;
  if (typeof mediaType !== 'string') return null;
  if (
    ![
      'file',
      'file-data',
      'file-url',
      'image-data',
      'image-url',
      'audio',
      'image',
    ].includes(String(item.type))
  )
    return null;
  if (typeof item.data === 'string' || item.data instanceof Uint8Array) {
    return { type: 'file', mediaType, data: item.data };
  }
  if (typeof item.url === 'string') {
    try {
      return { type: 'file', mediaType, data: new URL(item.url) };
    } catch {
      return null;
    }
  }
  if (item.type === 'file' && item.data !== undefined) return value as FilePart;
  return null;
}

/** Collect only media; the history view remains the authority for safe transcript text. */
export function collectMedia(
  messages: readonly ModelMessage[],
): Array<FilePart | ImagePart> {
  const media: Array<FilePart | ImagePart> = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'file' || part.type === 'image') media.push(part);
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      let items: unknown = output.type === 'content' ? output.value : undefined;
      if (
        (output.type === 'json' || output.type === 'error-json') &&
        output.value &&
        typeof output.value === 'object' &&
        'content' in output.value
      )
        items = output.value.content;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const projected = projectToolMedia(item);
        if (projected) media.push(projected);
      }
    }
  }
  return media;
}
