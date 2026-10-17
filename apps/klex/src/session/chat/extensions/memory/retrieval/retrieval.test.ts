import { describe, expect, it } from 'vitest';

import {
  compactRecallScopeSchema,
  recallFingerprint,
  recallInputSchema,
  renderRecall,
} from './retrieval';

describe('retrieval contracts', () => {
  it('trims questions and compact scopes', () => {
    const input = recallInputSchema.parse({
      question: '  What did I do?  ',
      scope: '  slack conversation:C123 user:U456  ',
    });
    expect(input).toEqual({
      question: 'What did I do?',
      scope: 'slack conversation:C123 user:U456',
    });
  });

  it.each([
    'chat',
    'slack conversation:C123 user:U456',
    'GitHub stagewise-io/klex PR #222',
    "Julian's work on deployment previews",
    'x'.repeat(256),
  ])('accepts recall input scope %s', (scope) => {
    expect(
      recallInputSchema.parse({ question: ' q ', scope: ` ${scope} ` }),
    ).toEqual({
      question: 'q',
      scope,
    });
  });

  it.each(['', '   ', 123, null, {}, 'x'.repeat(257)])(
    'rejects invalid recall input scope %j',
    (scope) => {
      expect(
        recallInputSchema.safeParse({ question: 'q', scope }).success,
      ).toBe(false);
    },
  );

  it('allows omitted scope and retains strict question and field validation', () => {
    expect(recallInputSchema.parse({ question: ' q ' })).toEqual({
      question: 'q',
    });
    expect(recallInputSchema.safeParse({ question: ' ' }).success).toBe(false);
    expect(
      recallInputSchema.safeParse({ question: 'q', extra: true }).success,
    ).toBe(false);
  });

  it('keeps returned scopes compact and bounded', () => {
    expect(() =>
      compactRecallScopeSchema.parse('the billing migration chat'),
    ).toThrow();
    expect(() =>
      compactRecallScopeSchema.parse(`slack ${'x'.repeat(300)}`),
    ).toThrow();
  });

  it('fingerprints recalls case-insensitively per scope', () => {
    expect(recallFingerprint({ question: 'Who is Ada?', scope: 'Slack' })).toBe(
      recallFingerprint({ question: ' who is ada? ', scope: 'slack' }),
    );
    expect(recallFingerprint({ question: 'Who is Ada?' })).not.toBe(
      recallFingerprint({ question: 'Who is Ada?', scope: 'slack' }),
    );
  });

  it('renders a recall block with its id and a scope placeholder', () => {
    expect(
      renderRecall({ question: 'Who is Ada?', scope: 'slack' }, 'r1'),
    ).toBe('<recall id="r1">\n[slack] Who is Ada?\n</recall>');
    expect(renderRecall({ question: 'Who is Ada?' }, 'r2')).toBe(
      '<recall id="r2">\n[unspecified scope] Who is Ada?\n</recall>',
    );
  });
});
