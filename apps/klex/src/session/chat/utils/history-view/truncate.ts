import type { FieldLimit, ValueLimit } from './types';

const MAX_NODES = 200;
const MAX_STRING_LENGTH = 600;
const MAX_DEPTH = 3;

/**
 * Truncates `text` to `limit`. Non-positive limits yield `''` for the
 * length-bounded styles and `'…'` for `end-overflow`.
 */
export function truncateText(text: string, limit: FieldLimit): string {
  const max = Math.max(0, Math.floor(limit.max));
  if (text.length <= max) return text;
  switch (limit.truncate) {
    case 'end':
      return max === 0 ? '' : `${text.slice(0, max - 1)}…`;
    case 'middle': {
      if (max === 0) return '';
      const keep = max - 1;
      const head = Math.ceil(keep / 2);
      const tail = Math.floor(keep / 2);
      return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`;
    }
    case 'end-overflow':
      return `${text.slice(0, max)}…`;
  }
}

/**
 * Serializes and truncates a value; `null` when there is nothing to show.
 * `plain` and `lines` treat empty strings as nothing, `compact` keeps them.
 */
export function serializeValue(
  value: unknown,
  limit: ValueLimit,
): string | null {
  const serialized = serializeJson(value, limit.json);
  if (serialized === null) return null;
  if (serialized === '' && limit.json !== 'compact') return null;
  return truncateText(serialized, limit);
}

function serializeJson(
  value: unknown,
  json: ValueLimit['json'],
): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (json === 'compact') return compactJson(value);
  if (json === 'lines') return keyValueLines(value);
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

type Scalar = string | number | boolean | bigint | null;

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    ['string', 'number', 'boolean', 'bigint'].includes(typeof value)
  );
}

/**
 * Flattens a value to `path: value` lines (`a.b: 1`, `tags: x, y`), bounded
 * by node count and depth; deeper values fall back to compact JSON.
 * Empty objects yield `''`. Never throws.
 */
export function keyValueLines(value: unknown): string {
  if (isScalar(value)) return String(value);
  const lines: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, path: string, depth: number): boolean => {
    if (++nodes > MAX_NODES) {
      lines.push('…');
      return false;
    }
    const push = (text: string) => lines.push(path ? `${path}: ${text}` : text);
    if (isScalar(current)) {
      push(String(current));
      return true;
    }
    // undefined, functions, and symbols are dropped, as in JSON.
    if (typeof current !== 'object') return true;
    if (seen.has(current)) {
      push('[Circular]');
      return true;
    }
    seen.add(current);
    if (
      Array.isArray(current) &&
      current.length > 0 &&
      current.every(isScalar)
    ) {
      push(current.map(String).join(', '));
      return true;
    }
    if (depth >= MAX_DEPTH) {
      push(compactJson(current));
      return true;
    }
    const entries = Object.entries(current);
    if (entries.length === 0) {
      if (path) push(Array.isArray(current) ? '[]' : '{}');
      return true;
    }
    for (const [childKey, child] of entries) {
      if (!visit(child, path ? `${path}.${childKey}` : childKey, depth + 1)) {
        return false;
      }
    }
    return true;
  };

  visit(value, '', 0);
  return lines.join('\n');
}

/** Node- and string-bounded JSON that never throws. */
export function compactJson(value: unknown): string {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'string') {
    return JSON.stringify(value.slice(0, MAX_STRING_LENGTH));
  }

  let nodes = 0;
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (++nodes > MAX_NODES) {
        throw new Error('compact JSON node limit exceeded');
      }
      if (typeof nestedValue === 'string') {
        return nestedValue.slice(0, MAX_STRING_LENGTH);
      }
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        if (seen.has(nestedValue)) return '[Circular]';
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    return result ?? '[undefined]';
  } catch {
    return '[unserializable]';
  }
}
