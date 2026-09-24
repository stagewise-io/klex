import { describe, expect, it } from 'vitest';

import { createTranscriptHistoryView } from './presets';
import { GOLDEN_HISTORY, LONG_HISTORY } from './test-fixtures';

// Consult and compaction share the line-format transcript preset.

function compaction(history: typeof GOLDEN_HISTORY): string {
  return createTranscriptHistoryView().render(history).text;
}

function consult(
  history: typeof GOLDEN_HISTORY,
  maxCharacters = 12_000,
  recentMessageLimit = 5,
): string {
  return createTranscriptHistoryView({
    keep: 'newest',
    maxCharacters,
    recentMessageLimit,
  }).render(history).text;
}

describe('golden history views', () => {
  it('compaction transcript over full history', () => {
    expect(compaction(GOLDEN_HISTORY)).toMatchSnapshot();
  });

  it('compaction transcript from the latest summary', () => {
    expect(compaction(GOLDEN_HISTORY.slice(3))).toMatchSnapshot();
  });

  it('compaction transcript without summary', () => {
    expect(compaction(GOLDEN_HISTORY.slice(0, 3))).toMatchSnapshot();
  });

  it('consult context with default budget', () => {
    expect(consult(GOLDEN_HISTORY)).toMatchSnapshot();
  });

  it('consult context with a small budget', () => {
    expect(consult(GOLDEN_HISTORY, 1_500)).toMatchSnapshot();
  });

  it('consult context with a tiny budget', () => {
    expect(consult(GOLDEN_HISTORY, 10)).toMatchSnapshot();
  });

  it('consult context over long history', () => {
    expect(consult(LONG_HISTORY, 3_000, 10)).toMatchSnapshot();
  });
});
