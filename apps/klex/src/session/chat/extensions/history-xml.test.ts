import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '../message-types';
import { CONTEXT_SUMMARY_KEY, serializeHistoryAsXml } from './history-xml';

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
        ? [
            {
              type: `data-${CONTEXT_SUMMARY_KEY}`,
              data: { summary },
            } as never,
          ]
        : []),
    ],
  };
}

describe('serializeHistoryAsXml', () => {
  it('uses the latest summary when truncating', () => {
    const result = serializeHistoryAsXml(
      [
        message('old-summary', 'old', 'older summary'),
        message('middle', 'middle'),
        message('new-summary', 'new', 'newer summary'),
      ],
      { maxCharacters: 140, summaryKey: CONTEXT_SUMMARY_KEY },
    );

    expect(result).toContain('newer summary');
    expect(result).not.toContain('older summary');
  });

  it('falls back to the truncated marker when newest message exceeds budget', () => {
    const result = serializeHistoryAsXml(
      [message('old', 'small'), message('new', 'x'.repeat(500))],
      { maxCharacters: 100 },
    );

    expect(result).toBe('<history-truncated />');
  });

  it('retains the latest summary in addition to the recent ordinary suffix', () => {
    const result = serializeHistoryAsXml(
      [
        message('summary', 'summary message', 'durable facts'),
        message('old', 'old ordinary'),
        message('middle', 'middle ordinary'),
        message('new', 'new ordinary'),
      ],
      {
        recentMessageLimit: 2,
        summaryKey: CONTEXT_SUMMARY_KEY,
      },
    );

    expect(result).toContain('durable facts');
    expect(result).not.toContain('old ordinary');
    expect(result).toContain('middle ordinary');
    expect(result).toContain('new ordinary');
  });

  it('does not duplicate a summary inside the recent range', () => {
    const result = serializeHistoryAsXml(
      [message('ordinary', 'ordinary'), message('summary', 'latest', 'facts')],
      { recentMessageLimit: 2, summaryKey: CONTEXT_SUMMARY_KEY },
    );

    expect(result.match(/<summary>/g)).toHaveLength(1);
    expect(result.match(/latest/g)).toHaveLength(1);
  });

  it('selects the newest ordinary messages when no summary exists', () => {
    const result = serializeHistoryAsXml(
      [
        message('old', 'old'),
        message('middle', 'middle'),
        message('new', 'new'),
      ],
      { recentMessageLimit: 2, summaryKey: CONTEXT_SUMMARY_KEY },
    );

    expect(result).not.toContain('<text>old</text>');
    expect(result).toContain('<text>middle</text>');
    expect(result).toContain('<text>new</text>');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats an invalid recent-message limit (%s) as zero',
    (recentMessageLimit) => {
      const result = serializeHistoryAsXml(
        [message('summary', 'summary message', 'facts'), message('new', 'new')],
        {
          recentMessageLimit,
          summaryKey: CONTEXT_SUMMARY_KEY,
        },
      );

      expect(result).toContain('facts');
      expect(result).not.toContain('<text>new</text>');
    },
  );

  it('applies the character budget after recent-message selection', () => {
    const result = serializeHistoryAsXml(
      [
        message('summary', 'summary', 'facts'),
        message('old', 'old'),
        message('middle', 'middle'),
        message('new', 'x'.repeat(500)),
      ],
      {
        maxCharacters: 100,
        recentMessageLimit: 2,
        summaryKey: CONTEXT_SUMMARY_KEY,
      },
    );

    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('facts');
    expect(result).not.toContain('<text>old</text>');
    expect(result).not.toContain('<text>middle</text>');
  });

  it('never exceeds a tiny character budget', () => {
    expect(
      serializeHistoryAsXml([message('one', 'content')], { maxCharacters: 5 }),
    ).toHaveLength(5);
  });
});
