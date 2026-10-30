import { describe, expect, it } from 'vitest';

import { summaryRejectionReason } from './summary-validation';

describe('summaryRejectionReason', () => {
  it.each([
    ['', 'empty'],
    [' \n\t ', 'empty'],
    ['{"error":"cannot summarize"}', 'error'],
    ['{"refusal":"not supported"}', 'error'],
    ['{"status":"denied"}', 'control-envelope'],
    ['{"ref":"message-id","view":"list"}', 'control-envelope'],
    ['```json\n{"error":{"message":"refused"}}\n```', 'error'],
    [
      'Sorry, I can’t help with identifying or analyzing who’s speaking in an audio clip.',
      'refusal',
    ],
    ["I'm sorry, but I cannot identify a speaker.", 'refusal'],
    ['I’m unable to summarize this recording.', 'refusal'],
    ["Unfortunately, I can't process this audio.", 'refusal'],
    ['I cannot provide a summary of this conversation.', 'refusal'],
    ['I apologize, but I will not assist with that.', 'refusal'],
  ] as const)('rejects %j as %s', (text, reason) => {
    expect(summaryRejectionReason(text)).toBe(reason);
  });

  it.each([
    'Summary of earlier work.',
    '- The user asked for learnings from the research.\n- Audio mentions ranking benchmarks.',
    '- The assistant replied: "Sorry, I can’t help with identifying who’s speaking."',
    'The provider returned {"error":"quota exceeded"}; retry remains pending.',
    'The user said I cannot access the server; they need credentials.',
    '- I cannot reproduce the reported timeout. Investigation remains open.',
    'I cannot reproduce the reported timeout. Investigation remains open.',
    '{"summary":"The API returned an error."}',
    '{"status":"denied","summary":"The deployment was denied; retry is pending."}',
    'The model replied {"status":"denied"}; I retained the original context.',
  ])(
    'preserves legitimate summaries including historical failures: %j',
    (text) => {
      expect(summaryRejectionReason(text)).toBeNull();
    },
  );
});
