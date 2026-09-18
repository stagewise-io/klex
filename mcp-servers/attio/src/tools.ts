import { z } from 'zod/v4';

import { AttioError } from './errors.js';

const object = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const record_id = z.uuid();
const values = z.record(z.string().min(1).max(128), z.json());
export const toolSchemas = {
  query_records: z.strictObject({
    object,
    filter: z.record(z.string(), z.json()).optional(),
    sorts: z
      .array(
        z.strictObject({
          attribute: z.string().min(1).max(128),
          direction: z.enum(['asc', 'desc']),
          field: z.string().min(1).max(128).optional(),
        }),
      )
      .max(20)
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  }),
  search_records: z.strictObject({
    query: z.string().min(1).max(256),
    objects: z.array(object).min(1).max(20),
    limit: z.number().int().min(1).max(25).default(25),
  }),
  get_record: z.strictObject({ object, record_id }),
  create_record: z.strictObject({ object, values }),
  update_record_append: z.strictObject({ object, record_id, values }),
  update_record_replace: z.strictObject({ object, record_id, values }),
};
export type ToolName = keyof typeof toolSchemas;
export const descriptions: Record<ToolName, string> = {
  query_records:
    'Query records with Attio structured filters and sorts. Explicit limit/offset pagination; no inferred filters.',
  search_records:
    'Fuzzy search record summaries (beta, eventually consistent). Verify writes with get or query.',
  get_record: 'Get a record and its typed attribute values.',
  create_record: 'Create a record. Conflicts are errors; never upserts.',
  update_record_append:
    'PATCH supplied attributes. Preserve existing multiselect values; new values are prepended by Attio, not guaranteed tail ordering. Scalars are updated.',
  update_record_replace:
    'PUT replaces values of supplied attributes, including multiselects. Empty arrays clear values; omitted attributes remain unchanged. Concurrent writes can lose changes.',
};
export interface Operation {
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  read: boolean;
  search?: boolean;
  limit?: number;
  offset?: number;
}
export function boundedInput(input: unknown): void {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 16) throw new AttioError('INVALID_INPUT');
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) walk(child, depth + 1);
  };
  try {
    walk(input, 0);
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > 65_536)
      throw new Error();
  } catch {
    throw new AttioError('INVALID_INPUT');
  }
}
export function operation(name: ToolName, input: unknown): Operation {
  boundedInput(input);
  const parsed = toolSchemas[name]?.safeParse(input);
  if (!parsed?.success) throw new AttioError('INVALID_INPUT');
  const data = parsed.data;
  if (name === 'search_records' && 'query' in data)
    return {
      path: '/v2/objects/records/search',
      method: 'POST',
      body: { ...data, request_as: { type: 'workspace' } },
      read: true,
      search: true,
      limit: data.limit,
    };
  if (!('object' in data)) throw new AttioError('INVALID_INPUT');
  const base = `/v2/objects/${encodeURIComponent(data.object)}/records`;
  if (name === 'query_records' && 'offset' in data) {
    const { object: _, ...body } = data;
    return {
      path: `${base}/query`,
      method: 'POST',
      body,
      read: true,
      limit: data.limit,
      offset: data.offset,
    };
  }
  const path = 'record_id' in data ? `${base}/${data.record_id}` : base;
  if (name === 'get_record') return { path, method: 'GET', read: true };
  if (!('values' in data)) throw new AttioError('INVALID_INPUT');
  return {
    path,
    method:
      name === 'create_record'
        ? 'POST'
        : name === 'update_record_append'
          ? 'PATCH'
          : 'PUT',
    body: { data: { values: data.values } },
    read: false,
  };
}
