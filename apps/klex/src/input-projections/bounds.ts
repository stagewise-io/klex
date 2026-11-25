import type { ContextDataUIPart, ContextMetadataValue } from '@/session/inbox';

/** Bytes are a conservative token ceiling, not the bytes/4 estimate used for scheduling. */
export const limits = {
  metadataBytes: 8_192,
  valueBytes: 1_024,
  textBytes: 4_096,
  contentItems: 16,
  preparationMs: 8_000,
  generationsPerPreparation: 2,
} as const;
const omitted = '[omitted; use raw details]';

function prefix(text: string, bytes: number): string {
  let result = '';
  let size = 0;
  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > bytes) break;
    result += character;
  }
  return result;
}

/** Bounded JSON preview. Arrays stay atomic and strings are never parsed. */
export function preview(
  value: unknown,
  maxBytes = limits.metadataBytes,
): unknown {
  let remaining = maxBytes - 128;
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 128 || depth > 16 || remaining < 128) return omitted;
    if (typeof item === 'string') {
      const budget = Math.max(0, Math.min(limits.valueBytes, remaining - 128));
      const text =
        Buffer.byteLength(JSON.stringify(item)) <= budget
          ? item
          : prefix(item, Math.floor(budget / 6));
      const result = text === item ? text : `${text}… ${omitted}`;
      remaining -= Buffer.byteLength(JSON.stringify(result));
      return result;
    }
    if (Array.isArray(item)) {
      const text = JSON.stringify(item);
      if (
        Buffer.byteLength(text) > Math.min(limits.valueBytes, remaining - 128)
      )
        return omitted;
      remaining -= Buffer.byteLength(text);
      return structuredClone(item);
    }
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort(
        (a, b) =>
          Number(/^(message|messages|text|body|content)$/i.test(b)) -
          Number(/^(message|messages|text|body|content)$/i.test(a)),
      )) {
        if (nodes >= 128 || remaining < 256 || Buffer.byteLength(key) > 128) {
          Object.defineProperty(result, '_omitted', {
            value: omitted,
            enumerable: true,
          });
          break;
        }
        remaining -= Buffer.byteLength(JSON.stringify(key)) + 4;
        Object.defineProperty(result, key, {
          value: visit((item as Record<string, unknown>)[key], depth + 1),
          enumerable: true,
        });
      }
      return result;
    }
    remaining -= 32;
    return item;
  };
  const result = visit(value, 0);
  return Buffer.byteLength(JSON.stringify(result)) <= maxBytes
    ? result
    : omitted;
}

/** No semantic field, identity plan, fallback, or transport string bypasses these limits. */
export function boundContext(context: ContextDataUIPart): ContextDataUIPart {
  const {
    inputEventRef: _ref,
    moreInfoSections: _sections,
    ...fields
  } = context.metadata;
  const metadata = preview(fields) as ContextMetadataValue;
  let remaining = limits.textBytes as number;
  const content = context.content.slice(0, limits.contentItems).map((block) => {
    // Native media bytes are not text tokens; keep their ordered native representation.
    if (block.type === 'image' || block.type === 'audio') {
      if (
        /^(image|audio)\/[a-zA-Z0-9.+-]{1,64}$/.test(block.mimeType) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
      )
        return { type: block.type, mimeType: block.mimeType, data: block.data };
      return {
        type: 'text' as const,
        text: '[invalid media omitted; use content details]',
      };
    }
    const text = JSON.stringify(block);
    if (Buffer.byteLength(text) <= remaining) {
      remaining -= Buffer.byteLength(text);
      return block;
    }
    const bounded = prefix(text, Math.floor(Math.max(0, remaining - 128) / 6));
    remaining = 0;
    return { type: 'text' as const, text: `${bounded}… ${omitted}` };
  });
  const changed =
    JSON.stringify(metadata) !== JSON.stringify(context.metadata) ||
    JSON.stringify(content) !== JSON.stringify(context.content) ||
    context.sourceEnv.length > 128;
  return {
    ...context,
    sourceEnv: prefix(context.sourceEnv, 128),
    metadata: {
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata
        : { preview: metadata }),
      ...(changed ? { inputPreviewLimited: true } : {}),
    },
    content,
  };
}
