import { describe, expect, it } from 'vitest';

import { catalog, compile } from './catalog';
import { createInputProjections } from './input-projections';
import { select } from './projection';

// Safety contracts for previously reproduced audit failures.
describe('input projection audit reproductions', () => {
  it('fallback preserves small conversational arrays', () => {
    const service = createInputProjections();
    const data = {
      messages: [{ text: 'Production is down. Roll back now.' }],
      internalRecipient: 'required-action-destination',
      traceId: 'x'.repeat(8_000),
    };
    const result = service.project({
      sourceEnv: 'audit',
      metadata: { origin: 'events', data },
      content: [],
    });
    expect(result.status).toBe('fallback');
    expect(result.context.metadata.data).toMatchObject({
      messages: data.messages,
    });
  });

  it('fallback retains a bounded preview beyond 128 leaves', () => {
    const service = createInputProjections();
    const data = {
      message: 'Critical instruction that should remain visible',
      ...Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [`field${i}`, 'x'.repeat(40)]),
      ),
    };
    expect(catalog(data).complete).toBe(false);
    expect(
      service.project({
        sourceEnv: 'audit',
        metadata: { origin: 'events', data },
        content: [],
      }).context.metadata.data,
    ).toMatchObject({ message: data.message });
  });

  it('helper selections cannot omit recognized conversational fields', () => {
    const input = catalog({ message: 'Please help', traceId: 'opaque' });
    const plan = compile(input, {
      keep: [],
    });
    expect(select(plan, { message: 'Please help', traceId: 'opaque' })).toEqual(
      { message: 'Please help' },
    );
  });
});
