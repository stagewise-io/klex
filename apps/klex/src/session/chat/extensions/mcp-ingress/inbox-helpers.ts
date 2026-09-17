import type { ContextDataContent } from './resource-handlers';

// ---------------------------------------------------------------------------
// Inbox event size bounding
// ---------------------------------------------------------------------------

/** Truncates a UTF-8 string to fit within a byte budget, appending a notice. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n[Content truncated to fit the resource event limit]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(value.slice(0, middle), 'utf8') + suffixBytes <=
      maxBytes
    )
      low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

/**
 * Bounds an inbox event to a maximum serialized byte size. If the event
 * exceeds the limit, replaces content with a truncation notice and marks
 * metadata as truncated.
 */
export function boundInboxEvent<
  T extends {
    context: {
      metadata: Record<string, unknown>;
      content: ContextDataContent[];
    };
  },
>(event: T, maxBytes: number): T {
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') <= maxBytes)
    return event;

  const namespace = String(event.context.metadata.namespace ?? '');
  const uri = String(event.context.metadata.uri ?? '');
  const bounded = {
    ...event,
    context: {
      ...event.context,
      metadata: {
        namespace: truncateUtf8(namespace, 1_000),
        uri: truncateUtf8(uri, 2_000),
        diffKind: 'full',
        reason: 'significant-change',
        truncated: true,
      },
      content: [
        {
          type: 'text' as const,
          text: 'Resource update omitted because its serialized payload exceeded the event limit.',
        },
      ],
    },
  };
  return bounded as T;
}
