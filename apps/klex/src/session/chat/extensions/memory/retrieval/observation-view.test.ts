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
    });
  });

  it('keeps the newest content within the character budget', () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      msg(`n${i}`, 'user', [
        { type: 'text', text: `entry-${i} ${'y'.repeat(200)}` },
      ]),
    );
    const bounded = renderObservation(long, null, 1_000);

    expect(bounded.text.length).toBeLessThanOrEqual(1_000);
    expect(bounded.text).toContain('entry-39');
    expect(bounded.text).not.toContain('entry-0 ');
    expect(bounded.cursor).toBe('n39');
  });
});
