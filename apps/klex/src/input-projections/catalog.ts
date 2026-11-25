import { createHash } from 'node:crypto';

import z from 'zod';

export const sections = [
  'default',
  'routing',
  'objectIds',
  'links',
  'other',
] as const;
export type Section = (typeof sections)[number];
export const assignmentSchema = z.strictObject({
  assignments: z
    .array(z.strictObject({ fieldId: z.string(), section: z.enum(sections) }))
    .max(128),
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
        section: z.enum(sections),
      }),
    )
    .max(128),
});
export type Plan = z.infer<typeof planSchema>;
export interface CatalogField {
  fieldId: string;
  path: string[];
  type: string;
  sample: string;
}
export interface Catalog {
  fields: CatalogField[];
  complete: boolean;
  shape: string;
  bytes: number;
}
export const policy = {
  maxFields: 128,
  maxDepth: 16,
  sampleCharacters: 120,
  metadataTokens: 1_024,
  leafThreshold: 64,
  structuralMinimumBytes: 1_024,
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
      fieldId: `f${fields.length}`,
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
    bytes: Buffer.byteLength(JSON.stringify(value)),
  };
}
export function essential(path: readonly string[]): boolean {
  return /^(message|messages|text|body|content|caption|subject|title|description|error|status|sender|actor|replyTarget|replyTo|threadId|conversationId|channelId)$/i.test(
    path.at(-1) ?? '',
  );
}
export function compile(input: Catalog, output: unknown): Plan {
  if (!input.complete) throw new Error('Incomplete field catalog');
  const { assignments } = assignmentSchema.parse(output);
  const byId = new Map(
    assignments.map((entry) => [entry.fieldId, entry.section]),
  );
  if (
    byId.size !== assignments.length ||
    byId.size !== input.fields.length ||
    assignments.some(
      (entry) => !input.fields.some((field) => field.fieldId === entry.fieldId),
    )
  )
    throw new Error('Every field must be assigned exactly once');
  return planSchema.parse({
    version: 1,
    fields: input.fields.map(({ path, type, fieldId }) => ({
      path,
      type,
      section: essential(path) ? 'default' : byId.get(fieldId),
    })),
  });
}
export function isComplex(input: Catalog): boolean {
  return (
    (input.bytes / 4 >= policy.metadataTokens &&
      !(
        input.fields.length === 1 &&
        /(?:url|uri|link)$/i.test(input.fields[0]?.path.at(-1) ?? '')
      )) ||
    (input.bytes >= policy.structuralMinimumBytes &&
      input.fields.length >= policy.leafThreshold)
  );
}
