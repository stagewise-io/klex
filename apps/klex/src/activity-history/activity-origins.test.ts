import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { collectActivityOrigins } from './activity-origins';

function context(sourceEnv: string, sourceId?: unknown): ExtendedUIMessage {
  return {
    id: `${sourceEnv}-${String(sourceId)}`,
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: {
          sourceEnv,
          metadata: sourceId === undefined ? {} : ({ sourceId } as never),
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ],
  };
}

describe('collectActivityOrigins', () => {
  it('deduplicates origins in order of first appearance', () => {
    expect(
      collectActivityOrigins([
        context('slack', 'C1'),
        {
          id: 'reply',
          role: 'assistant',
          parts: [{ type: 'text', text: 'done' }],
        },
        context('klex-cloud', 'chat:conv-1'),
        context('slack', 'C1'),
        context('slack', 'C2'),
        null,
        context('klex-cloud', 'chat:conv-1'),
      ]),
    ).toEqual([
      { env: 'slack', sourceId: 'C1' },
      { env: 'klex-cloud', sourceId: 'chat:conv-1' },
      { env: 'slack', sourceId: 'C2' },
    ]);
  });

  it('keeps several context parts of one message', () => {
    const message = context('github', 'repo#1');
    message.parts.push(...context('github', 'repo#2').parts);
    expect(collectActivityOrigins([message])).toEqual([
      { env: 'github', sourceId: 'repo#1' },
      { env: 'github', sourceId: 'repo#2' },
    ]);
  });

  it('uses null for a missing or non-string sourceId', () => {
    expect(
      collectActivityOrigins([
        context('phone'),
        context('phone', 42),
        context('phone', ''),
      ]),
    ).toEqual([{ env: 'phone', sourceId: null }]);
  });

  it('returns an empty list for internal-only activity', () => {
    expect(
      collectActivityOrigins([
        {
          id: 'god',
          role: 'user',
          parts: [
            {
              type: 'data-god-message',
              data: { content: [{ type: 'text', text: 'do it' }] },
            },
          ],
        },
        { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      ]),
    ).toEqual([]);
  });

  it('skips malformed persisted context parts', () => {
    expect(
      collectActivityOrigins([
        {
          id: 'bad',
          role: 'user',
          parts: [
            { type: 'data-context', data: null as never },
            { type: 'data-context', data: { sourceEnv: '' } as never },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
