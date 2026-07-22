export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class JsonValidationError extends Error {
  override readonly name = 'JsonValidationError';
}

export function assertJsonValue(
  value: unknown,
  path = '$',
): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new JsonValidationError(`${path} must contain a finite number`);
  }
  const seen = new Set<object>();
  if (Array.isArray(value)) {
    assertJsonArray(value, path, seen);
    return;
  }
  if (typeof value === 'object') {
    assertJsonObject(value, path, seen);
    return;
  }
  throw new JsonValidationError(
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
  if (prototype !== Object.prototype && prototype !== null)
    throw new JsonValidationError(`${path} must be a plain object`);
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
      throw new JsonValidationError(`${path} must contain a finite number`);
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
  throw new JsonValidationError(
    `${path} contains unsupported type ${typeof value}`,
  );
}

function enter(value: object, path: string, seen: Set<object>): void {
  if (seen.has(value))
    throw new JsonValidationError(`${path} contains a cycle`);
  seen.add(value);
}
