import { createHash } from 'node:crypto';

import z from 'zod';

export const selectionSchema = z.strictObject({
  keep: z.array(z.array(z.string()).max(16)).max(128),
});
export const planSchema = z.strictObject({
  version: z.literal(1),
  identity: z.boolean().optional(),
  fallbackUntil: z.number().finite().optional(),
  fields: z
    .array(
      z.strictObject({
        path: z.array(z.string()).max(16),
        type: z.string(),
        keep: z.boolean(),
      }),
    )
    .max(128),
});
export type Plan = z.infer<typeof planSchema>;
export interface CatalogField {
  path: string[];
  type: string;
  sample: string;
}
export interface Catalog {
  fields: CatalogField[];
  complete: boolean;
  shape: string;
}
export const policy = {
  maxFields: 128,
  maxDepth: 16,
  sampleCharacters: 120,
} as const;
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function valueType(value: unknown): string {
  return value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value;
}
/** Arrays and strings are atomic: never inspect or interpret their contents. */
export function catalog(value: unknown): Catalog {
  const fields: CatalogField[] = [];
  let complete = true;
  const visit = (item: unknown, path: string[]) => {
    if (fields.length >= policy.maxFields || path.length > policy.maxDepth) {
      complete = false;
      return;
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const keys = Object.keys(item).sort();
      if (keys.length) {
        for (const key of keys) {
          if (!complete) break;
          visit((item as Record<string, unknown>)[key], [...path, key]);
        }
        return;
      }
    }
    fields.push({
      path,
      type: valueType(item),
      sample: Array.isArray(item)
        ? '[atomic array]'
        : typeof item === 'string'
          ? JSON.stringify(item.slice(0, policy.sampleCharacters))
          : JSON.stringify(item).slice(0, policy.sampleCharacters),
    });
  };
  visit(value, []);
  return {
    fields,
    complete,
    shape: digest(fields.map(({ path, type }) => [path, type])),
  };
}
export function essential(path: readonly string[]): boolean {
  return /^(message|messages|text|body|content|caption|subject|title|description|error|status|sender|actor|replyTarget|replyTo|threadId|conversationId|channelId)$/i.test(
    path.at(-1) ?? '',
  );
}
export function compile(input: Catalog, output: unknown): Plan {
  if (!input.complete) throw new Error('Incomplete field catalog');
  const { keep } = selectionSchema.parse(output);
  const selected = new Set(keep.map((path) => JSON.stringify(path)));
  const known = new Set(input.fields.map(({ path }) => JSON.stringify(path)));
  if (
    selected.size !== keep.length ||
    [...selected].some((path) => !known.has(path))
  )
    throw new Error('Keep paths must be unique catalog entries');
  return planSchema.parse({
    version: 1,
    fields: input.fields.map(({ path, type }) => ({
      path,
      type,
      keep: essential(path) || selected.has(JSON.stringify(path)),
    })),
  });
}
