import { describe, expect, it } from 'vitest';

import { catalog, compile } from './catalog';
import { edgeValues, nestedEvent, pushEvent } from './fixtures';
import { createInputProjections } from './input-projections';
import { compatible, page, select } from './projection';

const expectedDefault = {
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
  it('accepts only unique exact catalog paths and distinguishes dotted keys', () => {
    const input = catalog({ 'a.b': 1, a: { b: 2 } });
    for (const path of [['a.b'], ['a', 'b']]) {
      const plan = compile(input, { keep: [path] });
      expect(
        plan.fields.filter(({ keep }) => keep).map(({ path }) => path),
      ).toEqual([path]);
    }
    expect(compile(input, { keep: [] }).fields.every(({ keep }) => !keep)).toBe(
      true,
    );
    for (const keep of [[['a.b'], ['a.b']], [['unknown']], [['a']]])
      expect(() => compile(input, { keep })).toThrow();
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
    keep: input.fields
      .filter(
        ({ path }) =>
          !(
            path.includes('tracking') ||
            path.includes('id') ||
            path.includes('avatarUrl') ||
            path.includes('attachments')
          ),
      )
      .map(({ path }) => path),
  });
  it('selects child fields without exposing their siblings or mutating source', () => {
    const before = JSON.stringify(nestedEvent);
    expect(select(plan, nestedEvent.metadata.data)).toEqual(expectedDefault);
    expect(JSON.stringify(nestedEvent)).toBe(before);
  });
  it('retains atomic arrays and hostile object keys', () => {
    const data = catalog(edgeValues);
    const all = compile(data, {
      keep: data.fields.map(({ path }) => path),
    });
    expect(select(all, edgeValues)).toEqual(edgeValues);
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
      const result = page(value, 'abcdefgh', 'v1', cursor, 1_024);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        1_024,
      );
      text += result.chunk;
      cursor = result.nextCursor ?? undefined;
      if (cursor) expect(() => page(value, 'otherref', 'v1', cursor)).toThrow();
    } while (cursor);
    expect(JSON.parse(text)).toEqual(value);
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
    expect(
      service.project(small).context.metadata.inputFilterNote,
    ).toBeUndefined();
    expect(service.project(pushEvent).context.content).toEqual(
      pushEvent.content,
    );
  });
  it('bounds identity selections without adding producer metadata', () => {
    const large = {
      sourceEnv: 'test',
      metadata: { origin: 'events', data: { message: 'x'.repeat(10_000) } },
      content: [],
    };
    const input = catalog(large.metadata.data);
    const plan = compile(input, {
      keep: input.fields.map(({ path }) => path),
    });
    const bounded = service.project(large, { ...plan, identity: true });
    expect(bounded.status).toBe('unchanged');
    expect(bounded.context.metadata.inputFiltered).toBeUndefined();
    expect(bounded.context.metadata.inputFilterNote).toBeUndefined();
    expect(bounded.projectedBytes).toBeLessThan(bounded.originalBytes);
    expect(bounded.projectedBytes).toBe(
      Buffer.byteLength(JSON.stringify(bounded.context.metadata)),
    );
  });
  it('flags stale plans rather than silently hiding new fields', () => {
    const plan = compile(catalog({ message: 'hello' }), {
      keep: [['message']],
    });
    const result = service.project(nestedEvent, plan);
    expect(result.status).toBe('fallback');
    expect(result.context.metadata.inputFilterNote).toBeUndefined();
    expect(result.projectedBytes).toBeLessThan(result.originalBytes / 2);
  });
});
