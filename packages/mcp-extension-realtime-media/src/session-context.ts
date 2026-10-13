import { z } from 'zod/v4';

export const REALTIME_MEDIA_CONTEXT_MAX_BYTES = 4_096;
export const REALTIME_MEDIA_CONTEXT_MAX_DEPTH = 8;
export const REALTIME_MEDIA_CONTEXT_MAX_VALUES = 128;

/** Preflight before recursive parsing; diagnostics deliberately exclude input. */
export function isBoundedRealtimeMediaContext(value: unknown): boolean {
  let remaining = REALTIME_MEDIA_CONTEXT_MAX_VALUES;
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > REALTIME_MEDIA_CONTEXT_MAX_DEPTH)
      return false;
    if (input === null || typeof input === 'boolean') return true;
    if (typeof input === 'number') return Number.isFinite(input);
    if (typeof input === 'string')
      return input.length <= REALTIME_MEDIA_CONTEXT_MAX_BYTES;
    if (typeof input !== 'object' || ancestors.has(input)) return false;
    const array = Array.isArray(input);
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(input).length > 0) return false;
    // Non-enumerable hooks must not run during serialization.
    const toJSON = Object.getOwnPropertyDescriptor(input, 'toJSON');
    if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function'))
      return false;
    ancestors.add(input);
    try {
      if (array) {
        if (input.length > remaining) return false;
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          if (
            !descriptor ||
            !('value' in descriptor) ||
            !visit(descriptor.value, depth + 1)
          )
            return false;
        }
      } else {
        for (const key of Object.getOwnPropertyNames(input)) {
          if (key.length > REALTIME_MEDIA_CONTEXT_MAX_BYTES) return false;
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (
            !descriptor?.enumerable ||
            !('value' in descriptor) ||
            !visit(descriptor.value, depth + 1)
          )
            return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(input);
    }
  }
  try {
    if (!visit(value, 0)) return false;
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).length <=
        REALTIME_MEDIA_CONTEXT_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/** Output schema remains structural for JSON Schema generation. */
export function withBoundedRealtimeMediaContext<T extends z.ZodType>(
  schema: T,
) {
  return z
    .unknown()
    .transform((value, ctx) => {
      if (!isBoundedRealtimeMediaContext(value)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid or oversized realtime session context',
        });
        return z.NEVER;
      }
      return value;
    })
    .pipe(schema);
}
