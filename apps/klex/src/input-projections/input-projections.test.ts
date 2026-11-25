import { describe, expect, it } from 'vitest';

import { catalog, compile, isComplex } from './catalog';
import { edgeValues, nestedEvent, pushEvent } from './fixtures';
import { createInputProjections } from './input-projections';
import { compatible, page, select } from './projection';

// Fixture expectations intentionally do not depend on helper classifications.
export const expectedDefault = {
  message: 'Please review this',
  sender: { name: 'Alex', profile: { role: 'Engineer' } },
  replyTarget: 'thread-42',
  status: 'open',
};

describe('catalog contracts', () => {
  it('recurses objects but treats arrays and strings as atomic values', () => {
    const result = catalog(edgeValues);
    expect(result.complete).toBe(true);
    expect(result.fields.find((field) => field.path[0] === 'array')?.type).toBe(
      'array',
    );
    expect(
      result.fields.filter((field) => field.path[0] === 'array'),
    ).toHaveLength(1);
    expect(
      result.fields.some(
        (field) => field.path.join('/') === 'a.b/__proto__/value',
      ),
    ).toBe(true);
  });
  it('requires exactly one valid assignment per field', () => {
    const input = catalog({ a: 1, b: 2 });
    const assignments = input.fields.map(({ fieldId }) => ({
      fieldId,
      section: 'default',
    }));
    expect(compile(input, { assignments }).fields).toHaveLength(2);
    expect(() =>
      compile(input, { assignments: assignments.slice(1) }),
    ).toThrow();
    expect(() =>
      compile(input, { assignments: [assignments[0], assignments[0]] }),
    ).toThrow();
    expect(() =>
      compile(input, {
        assignments: [
          { fieldId: 'unknown', section: 'default' },
          assignments[0],
        ],
      }),
    ).toThrow();
  });
  it('shape ignores values, object key order, and array contents', () => {
    expect(catalog({ b: [1], a: 'x' }).shape).toBe(
      catalog({ a: 'y', b: [] }).shape,
    );
    expect(catalog({ a: 1 }).shape).not.toBe(catalog({ a: '1' }).shape);
  });
});

describe('deterministic projections', () => {
  const input = catalog(nestedEvent.metadata.data);
  const plan = compile(input, {
    assignments: input.fields.map((field) => ({
      fieldId: field.fieldId,
      section:
        field.path.includes('tracking') ||
        field.path.includes('id') ||
        field.path.includes('avatarUrl') ||
        field.path.includes('attachments')
          ? 'other'
          : 'default',
    })),
  });
  it('selects child fields without exposing their siblings or mutating source', () => {
    const before = JSON.stringify(nestedEvent);
    expect(select(plan, nestedEvent.metadata.data, 'default')).toEqual(
      expectedDefault,
    );
    expect(JSON.stringify(nestedEvent)).toBe(before);
  });
  it('retains atomic arrays and hostile object keys', () => {
    const data = catalog(edgeValues);
    const all = compile(data, {
      assignments: data.fields.map(({ fieldId }) => ({
        fieldId,
        section: 'default',
      })),
    });
    expect(select(all, edgeValues, 'default')).toEqual(edgeValues);
    expect({}).not.toHaveProperty('value');
  });
  it('accepts absent fields, rejects additions and type changes', () => {
    expect(compatible(plan, { message: 'Changed' })).toBe(true);
    expect(compatible(plan, { message: 'Changed', newField: 1 })).toBe(false);
    expect(compatible(plan, { message: 1 })).toBe(false);
    expect(compatible(plan, { sender: 'replaced' })).toBe(false);
  });
  it('paginates losslessly within UTF-8 budgets and binds cursors', () => {
    const value = { text: '😀\\"\\n'.repeat(5_000), array: [edgeValues] };
    let cursor: string | undefined;
    let text = '';
    do {
      const result = page(value, 'abcdefgh', 'raw', 'v1', cursor, 1_024);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        1_024,
      );
      text += result.chunk;
      cursor = result.nextCursor ?? undefined;
      if (cursor)
        expect(() => page(value, 'otherref', 'raw', 'v1', cursor)).toThrow();
    } while (cursor);
    expect(JSON.parse(text)).toEqual(value);
  });
  it('bounds catalogs and distinguishes content from large metadata', () => {
    expect(catalog({ text: 'x'.repeat(8_000) }).complete).toBe(true);
    expect(isComplex(catalog({ text: 'x'.repeat(8_000) }))).toBe(true);
    expect(isComplex(catalog({ url: 'https://example.test' }))).toBe(false);
    expect(
      catalog(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, i])))
        .complete,
    ).toBe(false);
  });
});

describe('fallback policy', () => {
  const service = createInputProjections();
  it('keeps ordinary events unchanged and content blocks untouched', () => {
    const small = {
      ...pushEvent,
      metadata: { origin: 'push-notifications', data: { message: 'hello' } },
    };
    expect(service.project(small).context).toEqual(small);
    expect(service.project(pushEvent).context.content).toEqual(
      pushEvent.content,
    );
  });
  it('flags stale plans rather than silently hiding new fields', () => {
    const plan = compile(catalog({ message: 'hello' }), {
      assignments: [{ fieldId: 'f0', section: 'default' }],
    });
    const result = service.project(nestedEvent, plan);
    expect(result.status).toBe('fallback');
    expect(result.context.metadata.moreInfoSections).toContain('raw');
    expect(result.projectedBytes).toBeLessThan(result.originalBytes / 2);
  });
  it('round trips seeded nested JSON through an all-default plan', () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 100; i++) {
      const value = {
        nested: {
          value: random() % 2 ? null : random(),
          empty: '',
          false: false,
        },
        array: [random(), { key: 'literal' }],
      };
      const input = catalog(value);
      const plan = compile(input, {
        assignments: input.fields.map(({ fieldId }) => ({
          fieldId,
          section: 'default',
        })),
      });
      expect(select(plan, value, 'default')).toEqual(value);
    }
  });
});

describe('projection fixtures', () => {
  it('covers both MCP origins and ordered native content', () => {
    expect(nestedEvent.metadata.origin).toBe('events');
    expect(pushEvent.metadata.origin).toBe('push-notifications');
    expect(pushEvent.content.map((block) => block.type)).toEqual([
      'text',
      'image',
      'resource_link',
    ]);
  });
  it('retains hostile keys, primitive edge values and literal JSON strings', () => {
    expect(Object.hasOwn(edgeValues['a.b'] as object, '__proto__')).toBe(true);
    expect(edgeValues.json).toBe('{"literal":true}');
    expect(expectedDefault.sender.profile).toEqual({ role: 'Engineer' });
  });
});
