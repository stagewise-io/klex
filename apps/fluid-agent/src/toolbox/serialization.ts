export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class SerializationError extends Error {
  override readonly name = 'SerializationError';
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export function assertJsonValue(
  value: unknown,
  path = '$',
): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new SerializationError(`${path} must contain a finite number`);
  }
  if (Array.isArray(value)) {
    const seen = new Set<object>();
    assertJsonArray(value, path, seen);
    return;
  }
  if (typeof value === 'object') {
    const seen = new Set<object>();
    assertJsonObject(value, path, seen);
    return;
  }
  throw new SerializationError(
    `${path} contains unsupported type ${typeof value}`,
  );
}

function assertJsonArray(
  value: unknown[],
  path: string,
  seen: Set<object>,
): void {
  enter(value, path, seen);
  for (const [index, item] of value.entries())
    assertJsonNode(item, `${path}[${index}]`, seen);
  seen.delete(value);
}

function assertJsonObject(
  value: object,
  path: string,
  seen: Set<object>,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SerializationError(`${path} must be a plain object`);
  }
  enter(value, path, seen);
  for (const [key, item] of Object.entries(value))
    assertJsonNode(item, `${path}.${key}`, seen);
  seen.delete(value);
}

function assertJsonNode(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new SerializationError(`${path} must contain a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    assertJsonArray(value, path, seen);
    return;
  }
  if (typeof value === 'object') {
    assertJsonObject(value, path, seen);
    return;
  }
  throw new SerializationError(
    `${path} contains unsupported type ${typeof value}`,
  );
}

function enter(value: object, path: string, seen: Set<object>): void {
  if (seen.has(value)) throw new SerializationError(`${path} contains a cycle`);
  seen.add(value);
}

export function serializedSize(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertSerializedSize(
  value: JsonValue,
  maximumBytes: number,
  label: string,
): void {
  const size = serializedSize(value);
  if (size > maximumBytes) {
    throw new SerializationError(`${label} exceeds ${maximumBytes} bytes`);
  }
}

export function toSerializedError(
  error: unknown,
  fallbackCode = 'TOOLBOX_ERROR',
): SerializedError {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : fallbackCode;
    return { name: error.name || 'Error', message: error.message, code };
  }
  return {
    name: 'Error',
    message: 'Unknown toolbox error',
    code: fallbackCode,
  };
}
