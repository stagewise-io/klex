import { catalog, digest, type Plan, type Section, valueType } from './catalog';

function read(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function assign(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(target, key))
      Object.defineProperty(target, key, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
    target = target[key] as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key !== undefined)
    Object.defineProperty(target, key, {
      value: structuredClone(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
}
export function compatible(plan: Plan, value: unknown): boolean {
  const input = catalog(value);
  if (!input.complete) return false;
  return (
    input.fields.every((field) =>
      plan.fields.some(
        (known) =>
          JSON.stringify(known.path) === JSON.stringify(field.path) &&
          known.type === field.type,
      ),
    ) &&
    plan.fields.every((field) => {
      const item = read(value, field.path);
      return item === undefined || valueType(item) === field.type;
    })
  );
}
export function select(plan: Plan, value: unknown, section: Section): unknown {
  const result: Record<string, unknown> = {};
  for (const field of plan.fields) {
    if (field.section !== section) continue;
    const item = read(value, field.path);
    if (item === undefined) continue;
    if (!field.path.length) return structuredClone(item);
    assign(result, field.path, item);
  }
  return result;
}
export interface DetailPage {
  status: 'ok';
  encoding: 'json-text-chunks';
  chunk: string;
  nextCursor: string | null;
}
/** JSON serialization is chunked, never parsed from a user string or truncated irrecoverably. */
export function page(
  value: unknown,
  reference: string,
  section: string,
  revision: string,
  cursor?: string,
  maxBytes = 12 * 1_024,
): DetailPage {
  if (maxBytes < 512) throw new Error('Page budget too small');
  const binding = digest([reference, section, revision]);
  let offset = 0;
  if (cursor) {
    if (cursor.length > 256) throw new Error('Invalid cursor');
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      parsed[0] !== binding ||
      !Number.isSafeInteger(parsed[1]) ||
      parsed[1] < 0
    )
      throw new Error('Invalid cursor');
    offset = parsed[1];
  }
  const text = JSON.stringify(value);
  if (
    offset > text.length ||
    (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ''))
  )
    throw new Error('Invalid cursor offset');
  let length = Math.min(text.length - offset, Math.floor((maxBytes - 384) / 6));
  if (/[\uD800-\uDBFF]/.test(text[offset + length - 1] ?? '')) length--;
  const end = offset + length;
  const result: DetailPage = {
    status: 'ok',
    encoding: 'json-text-chunks',
    chunk: text.slice(offset, end),
    nextCursor:
      end < text.length
        ? Buffer.from(JSON.stringify([binding, end])).toString('base64url')
        : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new Error('Page budget exceeded');
  return result;
}
