import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { createHistoryView } from './history-view';
import { LINES_TRUNCATION_MARKER } from './lines';
import type { HistoryBudget, HistoryFilterOptions } from './types';

const SUMMARY_KEY = 'context-summary';

const FILTER: HistoryFilterOptions = {
  text: {
    roles: ['user', 'assistant', 'system'],
    limit: { max: 500, truncate: 'end-overflow' },
    keepEmpty: true,
  },
  reasoning: false,
  tools: false,
  context: false,
  summary: { key: SUMMARY_KEY, limit: { max: 800, truncate: 'end-overflow' } },
};

function message(
  id: string,
  text: string,
  summary?: string,
): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [
      { type: 'text', text },
      ...(summary
        ? [{ type: `data-${SUMMARY_KEY}`, data: { summary } } as never]
        : []),
    ],
  };
}

function render(
  history: ExtendedUIMessage[],
  budget: HistoryBudget,
  filter: HistoryFilterOptions = FILTER,
) {
  return createHistoryView({ filter, budget }).render(history);
}

describe('keep newest', () => {
  it('uses the latest summary when truncating', () => {
    const { text } = render(
      [
        message('old-summary', 'old', 'older summary'),
        message('middle', 'middle'),
        message('new-summary', 'new', 'newer summary'),
      ],
      { keep: 'newest', maxCharacters: 140 },
    );

    expect(text).toContain('newer summary');
    expect(text).not.toContain('older summary');
  });

  it('falls back to the truncated marker when newest message exceeds budget', () => {
    const result = render(
      [message('old', 'small'), message('new', 'x'.repeat(500))],
      { keep: 'newest', maxCharacters: 100 },
      { ...FILTER, summary: false },
    );

    expect(result.text).toBe(LINES_TRUNCATION_MARKER);
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe('new');
  });

  it('retains the latest summary in addition to the recent ordinary suffix', () => {
    const { text } = render(
      [
        message('summary', 'summary message', 'durable facts'),
        message('old', 'old ordinary'),
        message('middle', 'middle ordinary'),
        message('new', 'new ordinary'),
      ],
      { keep: 'newest', recentMessageLimit: 2 },
    );

    expect(text).toContain('durable facts');
    expect(text).not.toContain('old ordinary');
    expect(text).toContain('middle ordinary');
    expect(text).toContain('new ordinary');
  });

  it('does not duplicate a summary inside the recent range', () => {
    const { text } = render(
      [message('ordinary', 'ordinary'), message('summary', 'latest', 'facts')],
      { keep: 'newest', recentMessageLimit: 2 },
    );

    expect(text.match(/^summary$/gm)).toHaveLength(1);
    expect(text.match(/latest/g)).toHaveLength(1);
  });

  it('selects the newest ordinary messages when no summary exists', () => {
    const { text } = render(
      [
        message('old', 'old'),
        message('middle', 'middle'),
        message('new', 'new'),
      ],
      { keep: 'newest', recentMessageLimit: 2 },
    );

    expect(text).not.toContain('¦old');
    expect(text).toContain('¦middle');
    expect(text).toContain('¦new');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats an invalid recent-message limit (%s) as zero',
    (recentMessageLimit) => {
      const { text } = render(
        [message('summary', 'summary message', 'facts'), message('new', 'new')],
        { keep: 'newest', recentMessageLimit },
      );

      expect(text).toContain('facts');
      expect(text).not.toContain('¦new');
    },
  );

  it('applies the character budget after recent-message selection', () => {
    const { text } = render(
      [
        message('summary', 'summary', 'facts'),
        message('old', 'old'),
        message('middle', 'middle'),
        message('new', 'x'.repeat(500)),
      ],
      { keep: 'newest', maxCharacters: 100, recentMessageLimit: 2 },
    );

    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain('facts');
    expect(text).not.toContain('¦old');
    expect(text).not.toContain('¦middle');
  });

  it('never exceeds a tiny character budget', () => {
    expect(
      render([message('one', 'content')], { keep: 'newest', maxCharacters: 5 })
        .text,
    ).toHaveLength(5);
  });
});

describe('keep oldest', () => {
  const history = Array.from({ length: 10 }, (_, index) =>
    message(`m${index}`, `${index}-${'x'.repeat(80)}`),
  );
  const noSummary = { ...FILTER, summary: false } as const;

  function oldest(
    input: ExtendedUIMessage[],
    cursor: string | null,
    maxCharacters: number,
  ) {
    return createHistoryView({
      filter: noSummary,
      budget: { keep: 'oldest', maxCharacters },
    }).render(input, { kind: 'after-cursor', cursor });
  }

  it('caps between messages and resumes from the returned cursor', () => {
    const first = oldest(history, null, 400);

    expect(first.text.length).toBeLessThanOrEqual(400);
    expect(first.truncated).toBe(true);
    expect(first.text).not.toContain(LINES_TRUNCATION_MARKER);
    expect(first.cursor).toBe('m3');

    const second = oldest(history, first.cursor, 10_000);
    expect(second.text.startsWith('user\n¦4-')).toBe(true);
    expect(second.cursor).toBe('m9');
    expect(second.truncated).toBe(false);
  });

  it('replays the whole history when the cursor is missing', () => {
    const result = oldest(history.slice(0, 2), 'removed', 10_000);

    expect(result.text).toContain('0-');
    expect(result.cursor).toBe('m1');
  });

  it('keeps an existing cursor when nothing follows it', () => {
    expect(oldest(history, 'm9', 10_000)).toEqual({
      text: '',
      segments: [],
      cursor: 'm9',
      truncated: false,
    });
  });

  it('advances across empty messages', () => {
    const empty: ExtendedUIMessage = {
      id: 'empty',
      role: 'assistant',
      parts: [{ type: 'step-start' } as never],
    };
    const result = oldest([...history.slice(0, 1), empty], 'm0', 10_000);

    expect(result.text).toBe('');
    expect(result.cursor).toBe('empty');
  });

  it('stalls on an oversized first message', () => {
    const big = [message('big', 'x'.repeat(400)), message('next', 'next')];

    expect(oldest(big, null, 100)).toMatchObject({
      text: '',
      cursor: null,
      truncated: true,
    });
  });
});
