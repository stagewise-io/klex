import { describe, expect, it, vi } from 'vitest';

import { createTranscriptHistoryView } from '@/session/chat/utils/history-view';

import { catalog, compile, isComplex } from './catalog';
import { generatePlan } from './generator';
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
    expect(result.context.metadata.moreInfoSections).toContain('other');
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

  it('the 64-leaf complexity trigger can invoke the helper', async () => {
    const input = catalog(
      Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [`field${i}`, 'x'.repeat(20)]),
      ),
    );
    expect(isComplex(input)).toBe(true);
    const generate = vi.fn().mockResolvedValue({ success: false });
    expect(
      await generatePlan(input, {
        generate,
        modelIds: [{ providerId: 'audit', modelId: 'chat' }],
      }),
    ).toBeUndefined();
    expect(generate).toHaveBeenCalled();
  });

  it('a long URL alone skips generation but remains size bounded', () => {
    const data = { url: `https://example.test/${'x'.repeat(5_000)}` };
    expect(isComplex(catalog(data))).toBe(false);
    const service = createInputProjections();
    expect(select(service.fallbackPlan(data)!, data, 'default')).toEqual({});
  });

  it('transcript truncation preserves the recovery header', () => {
    const text = createTranscriptHistoryView().render([
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
                moreInfoSections: ['other', 'raw'],
              },
              content: [],
            },
          },
        ],
      },
    ]).text;
    expect(text).toContain('Important conversational text');
    expect(text).toContain('abcdefgh');
    expect(text).toContain('moreInfoSections');
  });

  it('helper assignments cannot omit recognized conversational fields', () => {
    const input = catalog({ message: 'Please help', traceId: 'opaque' });
    const plan = compile(input, {
      assignments: input.fields.map(({ fieldId }) => ({
        fieldId,
        section: 'other',
      })),
    });
    expect(
      select(plan, { message: 'Please help', traceId: 'opaque' }, 'default'),
    ).toEqual({ message: 'Please help' });
  });
});
