import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { createHistoryView } from './history-view';
import type { HistoryFilterOptions } from './types';

const LIMIT = { max: 50, truncate: 'middle' } as const;

const FILTER: HistoryFilterOptions = {
  text: { roles: ['user'], limit: LIMIT },
  reasoning: false,
  tools: {
    input: { max: 30, truncate: 'end', json: 'plain' },
    output: false,
    error: false,
    skip: (name) => name === 'recall',
  },
  context: {
    metadata: { max: 100, truncate: 'middle', json: 'plain' },
    text: LIMIT,
    resources: { limit: LIMIT },
    media: 'placeholder',
  },
  summary: false,
  data: {
    time: (data) =>
      typeof data === 'object' && data !== null && 'label' in data
        ? { label: 'time', value: String(data.label) }
        : null,
  },
};

const HISTORY: ExtendedUIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'assistant prose is dropped' },
      {
        type: 'tool-search',
        toolCallId: 'c1',
        state: 'output-available',
        input: { query: 'q'.repeat(40) },
        output: 'hidden',
      } as never,
      {
        type: 'dynamic-tool',
        toolName: 'recall',
        toolCallId: 'c2',
        state: 'input-available',
        input: { query: 'x' },
      } as never,
    ],
  },
  {
    id: 'm1',
    role: 'user',
    parts: [{ type: 'text', text: 'memory result' }],
  },
  {
    id: 'c1',
    role: 'user',
    parts: [
      { type: 'data-time', data: { label: 'Friday' } } as never,
      { type: 'data-other', data: { a: 1 } } as never,
      {
        type: 'data-context',
        data: {
          sourceEnv: 'chat',
          metadata: { sourceId: 'c-1' },
          content: [
            { type: 'text', text: 'ping' },
            { type: 'resource_link', uri: 'chat://1', name: 'Chat' },
          ],
        },
      } as never,
    ],
  },
];

describe('createHistoryView', () => {
  it('filters, projects, and renders the whole history as lines', () => {
    const view = createHistoryView({
      filter: { ...FILTER, skipMessage: (message) => message.id === 'm1' },
    });
    const result = view.render(HISTORY);

    expect(result.text).toBe(
      [
        'user',
        '¦hello',
        '',
        'your_action search succeeded',
        `¦{"query":"${'q'.repeat(19)}…`,
        '',
        'time',
        '¦Friday',
        '',
        'context chat',
        '¦{"sourceId":"c-1"}',
        'text',
        '¦ping',
        'link',
        '¦uri: chat://1',
        '¦name: Chat',
      ].join('\n'),
    );
    expect(result.cursor).toBe('c1');
    expect(result.truncated).toBe(false);
  });

  it('renders only messages after the cursor and of the configured roles', () => {
    const result = createHistoryView({
      filter: { ...FILTER, roles: ['assistant'] },
    }).render(HISTORY, { kind: 'after-cursor', cursor: 'u1' });

    expect(result.text).toBe(
      `your_action search succeeded\n¦{"query":"${'q'.repeat(19)}…`,
    );
    expect(result.cursor).toBe('c1');
  });

  it('splices inline media into segments', () => {
    const result = createHistoryView({
      filter: { ...FILTER, context: { ...context(), media: 'inline' } },
    }).render([
      {
        id: 'x1',
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'whatsapp',
              metadata: {},
              content: [
                { type: 'text', text: 'look' },
                { type: 'image', mimeType: 'image/png', data: 'IMG' },
              ],
            },
          } as never,
        ],
      },
    ]);

    expect(result.text).toBe('context whatsapp\ntext\n¦look\nimage png');
    expect(result.segments).toContainEqual({
      type: 'media',
      kind: 'image',
      mediaType: 'image/png',
      data: 'IMG',
    });
  });

  it('defaults to the whole history and treats a null cursor as the start', () => {
    const view = createHistoryView({ filter: FILTER });

    expect(view.render(HISTORY)).toEqual(
      view.render(HISTORY, { kind: 'after-cursor', cursor: null }),
    );
    expect(view.render(HISTORY)).toEqual(view.render(HISTORY, { kind: 'all' }));
  });

  it('advances the cursor past trailing skipped messages', () => {
    const result = createHistoryView({
      filter: { ...FILTER, skipMessage: (message) => message.id === 'c1' },
    }).render(HISTORY, { kind: 'after-cursor', cursor: 'm1' });

    expect(result).toEqual({
      text: '',
      segments: [],
      cursor: 'c1',
      truncated: false,
    });
  });

  it('returns an empty view for empty history', () => {
    expect(createHistoryView({ filter: FILTER }).render([])).toEqual({
      text: '',
      segments: [],
      cursor: null,
      truncated: false,
    });
  });
});

function context() {
  return FILTER.context as Exclude<HistoryFilterOptions['context'], false>;
}
