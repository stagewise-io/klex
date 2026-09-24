import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { wrapMemoryResult } from './memory-result';
import { renderObservation } from './observation-view';

function msg(
  id: string,
  role: ExtendedUIMessage['role'],
  parts: unknown[],
): ExtendedUIMessage {
  return { id, role, parts: parts as ExtendedUIMessage['parts'] };
}

const HISTORY: ExtendedUIMessage[] = [
  msg('u1', 'user', [
    {
      type: 'data-context',
      data: {
        sourceEnv: 'whatsapp',
        metadata: { sourceId: 'chat-42', sender: 'Ada' },
        content: [
          { type: 'text', text: 'Can we move the review to Friday?' },
          { type: 'image', mimeType: 'image/png', data: 'SECRETPIXELS' },
          {
            type: 'resource',
            resource: { uri: 'file:///notes.md', text: 'launch notes' },
          },
        ],
      },
    },
  ]),
  msg('a1', 'assistant', [
    { type: 'reasoning', text: 'PRIVATE_REASONING' },
    { type: 'text', text: 'ASSISTANT_REPLY' },
    {
      type: 'tool-sendMessage',
      toolCallId: 't1',
      state: 'output-available',
      input: { to: 'Ada', text: 'x'.repeat(400) },
      output: { delivered: 'TOOL_OUTPUT' },
    },
    {
      type: 'tool-recall',
      toolCallId: 't2',
      state: 'output-available',
      input: { question: 'RECALL_QUESTION' },
      output: 'Recalling...',
    },
  ]),
  msg('m1', 'user', [{ type: 'text', text: wrapMemoryResult('MEMORY_TEXT') }]),
  msg('t1', 'user', [{ type: 'data-time', data: { label: 'TIME_UPDATE' } }]),
  msg('u2', 'user', [{ type: 'text', text: 'Thanks!' }]),
];

describe('renderObservation', () => {
  const { text, cursor } = renderObservation(HISTORY, null);

  it('keeps incoming context, user text, and tool-call summaries', () => {
    expect(text).toContain('whatsapp');
    expect(text).toContain('chat-42');
    expect(text).toContain('Can we move the review to Friday?');
    expect(text).toContain('file:///notes.md');
    expect(text).toContain('launch notes');
    expect(text).toContain('sendMessage');
    expect(text).toContain('Thanks!');
  });

  it('drops reasoning, assistant text, time, media, memory, and recall', () => {
    for (const hidden of [
      'PRIVATE_REASONING',
      'ASSISTANT_REPLY',
      'TIME_UPDATE',
      'SECRETPIXELS',
      'MEMORY_TEXT',
      'RECALL_QUESTION',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it('renders line-format records with prefixed content', () => {
    expect(text).toBe(
      [
        'context whatsapp',
        '¦sourceId: chat-42',
        '¦sender: Ada',
        'text',
        '¦Can we move the review to Friday?',
        'image png',
        'resource',
        '¦uri: file:///notes.md',
        'body',
        '¦launch notes',
        '',
        'your_action sendMessage succeeded',
        '¦to: Ada',
        `¦text: ${'x'.repeat(135)}…`,
        '',
        'user',
        '¦Thanks!',
      ].join('\n'),
    );
  });

  it('omits tool output and truncates tool input', () => {
    expect(text).not.toContain('TOOL_OUTPUT');
    expect(text).not.toContain('x'.repeat(200));
    expect(text).toContain('x'.repeat(100));
  });

  it('returns the last message in scope as cursor', () => {
    expect(cursor).toBe('u2');
  });

  it('renders only messages after the cursor', () => {
    const after = renderObservation(HISTORY, 'm1');

    expect(after.text).toContain('Thanks!');
    expect(after.text).not.toContain('whatsapp');
    expect(after.cursor).toBe('u2');
  });

  it('advances the cursor even when nothing is observable', () => {
    expect(renderObservation(HISTORY.slice(0, 4), 'a1')).toEqual({
      text: '',
      cursor: 't1',
      hasMore: false,
    });
  });

  it('renders nothing for assistant-only and recall-only deltas', () => {
    const history = [
      msg('a2', 'assistant', [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'reply' },
        {
          type: 'tool-recall',
          toolCallId: 't3',
          state: 'output-available',
          input: { question: 'q' },
          output: 'Recalling...',
        },
      ]),
      msg('m2', 'user', [{ type: 'text', text: wrapMemoryResult('x') }]),
    ];

    expect(renderObservation(history, null)).toEqual({
      text: '',
      cursor: 'm2',
      hasMore: false,
    });
  });

  it('drains a backlog oldest-first in budget-sized batches without loss', () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      msg(`n${i}`, 'user', [
        { type: 'text', text: `entry-${i} ${'y'.repeat(200)}` },
      ]),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let batch = 0; batch < 40; batch++) {
      const next = renderObservation(long, cursor, 1_000);
      expect(next.text.length).toBeLessThanOrEqual(1_000);
      expect(next.cursor).not.toBe(cursor);
      seen.push(...(next.text.match(/entry-\d+/gu) ?? []));
      cursor = next.cursor;
      if (!next.hasMore) break;
    }

    expect(seen).toEqual(long.map((_, i) => `entry-${i}`));
    expect(cursor).toBe('n39');
  });

  it('clips a single oversized message instead of dropping it', () => {
    const oversized = msg('big', 'user', [
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'data-context',
        data: {
          sourceEnv: 'slack',
          content: [{ type: 'text', text: `part-${i} ${'z'.repeat(400)}` }],
        },
      })),
    ]);
    const next = renderObservation([oversized], null);

    expect(next.text.length).toBeLessThanOrEqual(2_000);
    expect(next.text).toContain('part-0');
    expect(next.text).toMatch(/\[… \d+ more parts\]$/u);
    expect(next).toMatchObject({ cursor: 'big', hasMore: false });
  });
});
