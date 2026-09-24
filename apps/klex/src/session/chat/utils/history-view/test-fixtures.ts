import type { ExtendedUIMessage } from '@/session/chat/message-types';

const SUMMARY_KEY = 'context-summary';

function part(
  value: Record<string, unknown>,
): ExtendedUIMessage['parts'][number] {
  return value as never;
}

/**
 * Shared history covering every part type the history views handle. Used by
 * golden snapshot tests that pin the output of all consumer presets.
 */
export const GOLDEN_HISTORY: ExtendedUIMessage[] = [
  {
    id: 'u1',
    role: 'user',
    parts: [
      { type: 'text', text: 'Hello <world> & "friends" \'quoted\'' },
      part({
        type: 'data-time',
        data: {
          timestamp: Date.parse('2026-09-18T14:05:00.000Z') / 1000,
          tz: 'Europe/Berlin',
        },
      }),
    ],
  },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      part({ type: 'reasoning', text: `thinking ${'r'.repeat(700)} done` }),
      { type: 'text', text: `${'x'.repeat(700)}TAIL` },
      { type: 'text', text: '' },
      part({
        type: 'tool-search',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { query: 'billing <migration>' },
        output: { hits: [{ id: 1, title: 'Billing' }], note: 'y'.repeat(400) },
      }),
      part({
        type: 'tool-fetch',
        toolCallId: 'call-2',
        state: 'output-error',
        input: 'https://example.com',
        errorText: 'network down',
      }),
      part({
        type: 'tool-delete',
        toolCallId: 'call-3',
        state: 'output-denied',
        input: { path: '/tmp/x' },
      }),
      part({
        type: 'tool-wait',
        toolCallId: 'call-4',
        state: 'input-available',
        input: { seconds: 5 },
      }),
      part({ type: 'step-start' }),
    ],
  },
  {
    id: 's1',
    role: 'system',
    parts: [{ type: 'text', text: 'system note' }],
  },
  {
    id: 'sum1',
    role: 'user',
    parts: [
      part({
        type: `data-${SUMMARY_KEY}`,
        data: { summary: `Durable facts ${'s'.repeat(900)}` },
      }),
    ],
  },
  {
    id: 'c1',
    role: 'user',
    parts: [
      part({
        type: 'data-context',
        data: {
          sourceEnv: 'whatsapp',
          metadata: {
            sourceId: 'chat-1',
            type: 'message',
            resourceLink: { uri: 'whatsapp://chat/1' },
          },
          content: [
            { type: 'text', text: `Message from Anna: ${'m'.repeat(400)}` },
            { type: 'text', text: '' },
            { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
            { type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' },
            {
              type: 'resource_link',
              uri: 'https://example.com/doc',
              name: 'Doc <1>',
            },
            {
              type: 'resource',
              resource: { uri: 'file:///notes.txt', text: 'notes & more' },
            },
            {
              type: 'resource',
              resource: { uri: 'file:///blob.bin', blob: 'YmxvYg==' },
            },
          ],
        },
      }),
    ],
  },
  {
    id: 'a2',
    role: 'assistant',
    parts: [
      part({
        type: 'dynamic-tool',
        toolName: 'whatsapp_send',
        toolCallId: 'call-5',
        state: 'output-available',
        input: { chat: 'chat-1', text: 'Hi Anna' },
        output: 'sent',
      }),
    ],
  },
  {
    id: 'u2',
    role: 'user',
    parts: [part({ type: 'data-unknown-thing', data: { a: 1 } })],
  },
  {
    id: 'c2',
    role: 'user',
    parts: [
      part({
        type: 'data-context',
        data: {
          sourceEnv: 'github',
          metadata: {},
          content: Array.from({ length: 12 }, (_, index) => ({
            type: 'text',
            text: `${index}-${'g'.repeat(300)}`,
          })),
        },
      }),
    ],
  },
  {
    id: 'a3',
    role: 'assistant',
    parts: Array.from({ length: 12 }, (_, index) => ({
      type: 'text' as const,
      text: `${index}-${'p'.repeat(500)}`,
    })),
  },
  {
    id: 'a4',
    role: 'assistant',
    parts: [{ type: 'text', text: 'final answer' }],
  },
];

/** Long history of equally sized assistant messages for budget tests. */
export const LONG_HISTORY: ExtendedUIMessage[] = Array.from(
  { length: 30 },
  (_, index) => ({
    id: `l${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `${index}-${'l'.repeat(500)}` }],
  }),
);
