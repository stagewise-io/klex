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

  it('rejects semantic scope prose and oversized scopes', () => {
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
