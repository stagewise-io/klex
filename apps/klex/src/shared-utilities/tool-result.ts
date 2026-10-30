import type { ToolResultPart } from 'ai';

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
    return extractContentOutputText({ content: output.value.content });
  }
  const value =
    'type' in output && output.type === 'content' && 'value' in output
      ? output.value
      : 'content' in output
        ? output.content
        : null;
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
        const value = (part as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
      };
      return describeMediaContent({
        type: part.type,
        mediaType: field('mediaType'),
        mimeType: field('mimeType'),
        filename: field('filename'),
        url: field('url'),
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
