import { describe, expect, it } from 'vitest';

import type { SerializedMessage } from '../api-client';
import {
  getVisibleChatEntries,
  maxScrollOffset,
  toGodChatEntries,
} from './god-message-display';

function message(
  id: string,
  role: string,
  parts: SerializedMessage['parts'],
): SerializedMessage {
  return { id, role, parts };
}

describe('toGodChatEntries', () => {
  it('extracts god-message text and preserves message IDs', () => {
    const entries = toGodChatEntries([
      message('user-1', 'user', [
        {
          type: 'data-god-message',
          data: {
            content: [
              { type: 'text', text: 'Do this' },
              { type: 'image', data: '[redacted]' },
              { type: 'text', text: 'then that' },
            ],
          },
        },
      ]),
    ]);

    expect(entries).toEqual([
      { id: 'user-1', role: 'user', text: 'Do this\nthen that' },
    ]);
  });

  it('formats assistant text and tool states', () => {
    const entries = toGodChatEntries([
      message('agent-1', 'assistant', [
        { type: 'text', text: 'Working' },
        {
          type: 'tool-invocation',
          toolName: 'search',
          state: 'input-available',
          args: { query: 'test' },
        },
        {
          type: 'tool-invocation',
          toolName: 'search',
          state: 'output-available',
          result: { hits: 2 },
        },
        {
          type: 'tool-invocation',
          toolName: 'write',
          state: 'output-error',
          result: { error: 'denied' },
        },
      ]),
    ]);

    expect(entries).toEqual([
      {
        id: 'agent-1',
        role: 'assistant',
        text: [
          'Working',
          'Running search({"query":"test"})',
          'search() → {"hits":2}',
          'write() → error: denied',
        ].join('\n'),
      },
    ]);
  });

  it('handles circular values and omits non-displayable messages', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const entries = toGodChatEntries([
      message('reasoning', 'assistant', [
        { type: 'reasoning', text: 'private' },
      ]),
      message('tool', 'assistant', [
        {
          type: 'tool-invocation',
          toolName: 'tool',
          state: 'input-available',
          args: circular,
        },
      ]),
    ]);

    expect(entries).toEqual([
      {
        id: 'tool',
        role: 'assistant',
        text: 'Running tool([unserializable])',
      },
    ]);
  });

  it('truncates long tool values', () => {
    const [entry] = toGodChatEntries([
      message('tool', 'assistant', [
        {
          type: 'tool-invocation',
          toolName: 'tool',
          state: 'output-available',
          result: 'x'.repeat(200),
        },
      ]),
    ]);

    expect(entry?.text).toContain('...');
    expect(entry?.text.length).toBeLessThan(120);
  });
});

describe('chat windowing', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    role: 'assistant' as const,
    text: String(index),
  }));

  it('calculates a bounded maximum offset', () => {
    expect(maxScrollOffset(5, 3)).toBe(2);
    expect(maxScrollOffset(2, 3)).toBe(0);
  });

  it('shows the latest entries at offset zero', () => {
    const result = getVisibleChatEntries(entries, 3, 0);
    expect(result.visible.map(({ id }) => id)).toEqual(['2', '3', '4']);
    expect(result.scrollOffset).toBe(0);
  });

  it('clamps offsets beyond the oldest entry', () => {
    const result = getVisibleChatEntries(entries, 3, 100);
    expect(result.visible.map(({ id }) => id)).toEqual(['0', '1', '2']);
    expect(result.scrollOffset).toBe(2);
  });
});
