import { describe, expect, it } from 'vitest';

import { createTranscriptHistoryView } from '@/session/chat/utils/history-view';

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
    expect(result.context.metadata.inputFiltered).toBe(true);
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

  it('transcript truncation preserves the recovery header', () => {
    const text = createTranscriptHistoryView(
      undefined,
      undefined,
      undefined,
      (context) => ({ ...context }),
    ).render([
      {
        id: 'audit',
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'audit',
              metadata: {
                origin: 'events',
                type: 'message',
                data: { message: 'Important conversational text '.repeat(30) },
                projectionStatus: 'projected',
                inputEventRef: 'abcdefgh',
              },
              content: [],
            },
          },
        ],
      },
    ]).text;
    expect(text).toContain('Important conversational text');
    expect(text).not.toContain('Important conversational text '.repeat(30));
    expect(text).toContain('abcdefgh');
    expect(text).toContain('getUnfilteredInput');
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
