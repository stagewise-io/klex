import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { applyScope, historyAfterCursor, projectMessage } from './project';
import type { HistoryFilterOptions, HistoryRecord } from './types';

const LIMIT = { max: 8, truncate: 'end' } as const;

const NOTHING: HistoryFilterOptions = {
  text: false,
  reasoning: false,
  tools: false,
  context: false,
  summary: false,
};

function msg(
  parts: unknown[],
  role: ExtendedUIMessage['role'] = 'assistant',
  id = 'm1',
): ExtendedUIMessage {
  return { id, role, parts: parts as ExtendedUIMessage['parts'] };
}

function records(
  message: ExtendedUIMessage,
  filter: Partial<HistoryFilterOptions>,
): HistoryRecord[] {
  return projectMessage(message, { ...NOTHING, ...filter }).records;
}

function context(data: Record<string, unknown>) {
  return {
    type: 'data-context',
    data: { sourceEnv: 'chat', metadata: {}, content: [], ...data },
  };
}

describe('applyScope', () => {
  const history = [msg([], 'user', 'a'), msg([], 'user', 'b')];

  it('keeps everything for `all` and null cursors', () => {
    expect(applyScope(history, { kind: 'all' })).toEqual({
      messages: history,
      startCursor: null,
    });
    expect(applyScope(history, { kind: 'after-cursor', cursor: null })).toEqual(
      { messages: history, startCursor: null },
    );
  });

  it('slices after an existing cursor', () => {
    expect(applyScope(history, { kind: 'after-cursor', cursor: 'a' })).toEqual({
      messages: [history[1]],
      startCursor: 'a',
    });
    expect(historyAfterCursor(history, 'b')).toEqual([]);
  });

  it('replays everything and drops a missing cursor', () => {
    expect(
      applyScope(history, { kind: 'after-cursor', cursor: 'gone' }),
    ).toEqual({ messages: history, startCursor: null });
    expect(historyAfterCursor(history, 'gone')).toBe(history);
  });
});

describe('projectMessage', () => {
  it('keeps identity and projects nothing for excluded roles or skipped messages', () => {
    const message = msg([{ type: 'text', text: 'hi' }], 'user');
    const text = { roles: ['user'] as const, limit: LIMIT };

    expect(projectMessage(message, { ...NOTHING, text })).toEqual({
      id: 'm1',
      role: 'user',
      hasSummary: false,
      records: [{ kind: 'text', text: 'hi' }],
    });
    expect(records(message, { text, roles: ['assistant'] })).toEqual([]);
    expect(records(message, { text, skipMessage: () => true })).toEqual([]);
  });

  it('flags summaries even when the message is filtered out', () => {
    const message = msg(
      [{ type: 'data-context-summary', data: { summary: 'facts' } }],
      'user',
    );
    const projected = projectMessage(message, {
      ...NOTHING,
      roles: ['assistant'],
      summary: { key: 'context-summary', limit: LIMIT },
    });

    expect(projected.hasSummary).toBe(true);
    expect(projected.records).toEqual([]);
  });

  describe('text', () => {
    const message = msg([
      { type: 'text', text: 'a long assistant text' },
      { type: 'text', text: '' },
    ]);

    it('projects only configured roles and truncates', () => {
      expect(
        records(message, { text: { roles: ['assistant'], limit: LIMIT } }),
      ).toEqual([{ kind: 'text', text: 'a long …' }]);
      expect(
        records(message, { text: { roles: ['user'], limit: LIMIT } }),
      ).toEqual([]);
    });

    it('keeps empty text only when requested', () => {
      expect(
        records(message, {
          text: { roles: ['assistant'], limit: LIMIT, keepEmpty: true },
        }),
      ).toEqual([
        { kind: 'text', text: 'a long …' },
        { kind: 'text', text: '' },
      ]);
    });
  });

  it('projects non-empty reasoning when enabled', () => {
    const message = msg([
      { type: 'reasoning', text: 'because reasons' },
      { type: 'reasoning', text: '' },
    ]);

    expect(records(message, { reasoning: { limit: LIMIT } })).toEqual([
      { kind: 'reasoning', text: 'because…' },
    ]);
    expect(records(message, {})).toEqual([]);
  });

  describe('tools', () => {
    const tools: Exclude<HistoryFilterOptions['tools'], false> = {
      input: { max: 20, truncate: 'end', json: 'plain' },
      output: { max: 20, truncate: 'end', json: 'compact' },
      error: LIMIT,
    };
    const message = msg([
      {
        type: 'tool-search',
        toolCallId: '1',
        state: 'output-available',
        input: { q: 'x' },
        output: { hits: 2 },
      },
      {
        type: 'dynamic-tool',
        toolName: 'fetch',
        toolCallId: '2',
        state: 'output-error',
        input: 'url',
        errorText: 'connection refused',
      },
      {
        type: 'tool-other',
        toolCallId: '3',
        state: 'output-error',
        input: undefined,
      },
      {
        type: 'tool-deny',
        toolCallId: '4',
        state: 'output-denied',
        input: {},
      },
      {
        type: 'tool-wait',
        toolCallId: '5',
        state: 'input-streaming',
        input: undefined,
      },
    ]);

    it('maps states and bounds fields', () => {
      expect(records(message, { tools })).toEqual([
        {
          kind: 'tool',
          name: 'search',
          status: 'succeeded',
          input: '{"q":"x"}',
          output: '{"hits":2}',
        },
        {
          kind: 'tool',
          name: 'fetch',
          status: 'failed',
          input: 'url',
          error: 'connect…',
        },
        {
          kind: 'tool',
          name: 'other',
          status: 'failed',
          error: 'unknown…',
        },
        { kind: 'tool', name: 'deny', status: 'denied', input: '{}' },
        { kind: 'tool', name: 'wait', status: 'pending' },
      ]);
    });

    it('omits disabled fields, skips tools, and truncates names', () => {
      expect(
        records(message, {
          tools: {
            name: { max: 3, truncate: 'end' },
            input: false,
            output: false,
            error: false,
            skip: (name) => name !== 'search' && name !== 'fetch',
          },
        }),
      ).toEqual([
        { kind: 'tool', name: 'se…', status: 'succeeded' },
        { kind: 'tool', name: 'fe…', status: 'failed' },
      ]);
    });

    it('drops tool parts when tools are disabled', () => {
      expect(records(message, {})).toEqual([]);
    });
  });

  describe('context', () => {
    const base: Exclude<HistoryFilterOptions['context'], false> = {
      metadata: false,
      text: LIMIT,
      resources: 'placeholder',
      media: 'placeholder',
    };
    const content = [
      { type: 'text', text: 'hello context' },
      { type: 'text', text: '' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
      { type: 'audio', mimeType: 'audio/wav', data: 'BBB' },
      { type: 'resource_link', uri: 'chat://conversation/1', name: 'Chat' },
      { type: 'resource', resource: { uri: 'file:///a', text: 'body text' } },
      { type: 'resource', resource: { uri: 'file:///b', blob: 'Q' } },
    ];
    const message = msg(
      [
        context({
          sourceEnv: 'whatsapp-server',
          metadata: { sourceId: 'c1' },
          content,
        }),
      ],
      'user',
    );

    it('projects placeholders by default', () => {
      expect(records(message, { context: base })).toEqual([
        {
          kind: 'context',
          source: 'whatsapp-server',
          items: [
            { kind: 'text', text: 'hello c…' },
            { kind: 'image', mimeType: 'image/png' },
            { kind: 'audio', mimeType: 'audio/wav' },
            { kind: 'resource_link' },
            { kind: 'resource' },
            { kind: 'resource' },
          ],
        },
      ]);
    });

    it('projects metadata, full resources, inline media, and empty text on request', () => {
      expect(
        records(message, {
          context: {
            source: { max: 5, truncate: 'end' },
            metadata: { max: 100, truncate: 'end', json: 'plain' },
            text: { max: 100, truncate: 'end' },
            keepEmptyText: true,
            resources: { limit: { max: 100, truncate: 'end' } },
            media: 'inline',
          },
        }),
      ).toEqual([
        {
          kind: 'context',
          source: 'what…',
          metadata: '{"sourceId":"c1"}',
          items: [
            { kind: 'text', text: 'hello context' },
            { kind: 'text', text: '' },
            { kind: 'image', mimeType: 'image/png', data: 'AAA' },
            { kind: 'audio', mimeType: 'audio/wav', data: 'BBB' },
            {
              kind: 'resource_link',
              uri: 'chat://conversation/1',
              name: 'Chat',
            },
            { kind: 'resource', uri: 'file:///a', text: 'body text' },
            { kind: 'resource', uri: 'file:///b' },
          ],
        },
      ]);
    });

    it('drops empty metadata objects', () => {
      const empty = msg([context({ metadata: {} })], 'user');

      expect(
        records(empty, {
          context: {
            ...base,
            metadata: { max: 100, truncate: 'end', json: 'plain' },
          },
        }),
      ).toEqual([{ kind: 'context', source: 'chat', items: [] }]);
    });

    it('drops context parts when context is disabled', () => {
      expect(records(message, {})).toEqual([]);
    });

    it('drops context with only empty text unless metadata remains', () => {
      const blank = msg(
        [
          context({
            metadata: { sourceId: 'c1' },
            content: [{ type: 'text', text: '' }],
          }),
        ],
        'user',
      );

      expect(records(blank, { context: base })).toEqual([]);
      expect(
        records(blank, {
          context: {
            ...base,
            metadata: { max: 100, truncate: 'end', json: 'lines' },
          },
        }),
      ).toEqual([
        {
          kind: 'context',
          source: 'chat',
          metadata: 'sourceId: c1',
          items: [],
        },
      ]);
    });
  });

  describe('summary and data parts', () => {
    const message = msg(
      [
        { type: 'data-context-summary', data: { summary: 'durable facts' } },
        { type: 'data-time', data: { label: 'Friday' } },
        { type: 'data-time', data: { invalid: true } },
        { type: 'data-other', data: { a: 'b'.repeat(20) } },
      ],
      'user',
    );
    const summary = { key: 'context-summary', limit: LIMIT };
    const projectors = {
      time: (data: unknown) =>
        typeof data === 'object' && data !== null && 'label' in data
          ? { label: 'time', value: String(data.label) }
          : null,
    };

    it('projects summaries and drops unconfigured data parts', () => {
      expect(records(message, { summary })).toEqual([
        { kind: 'summary', text: 'durable…' },
      ]);
    });

    it('uses projectors and drops rejected values', () => {
      expect(records(message, { data: projectors })).toEqual([
        { kind: 'data', label: 'time', value: 'Friday' },
      ]);
    });

    it('drops summary parts without a string summary', () => {
      const malformed = msg(
        [{ type: 'data-context-summary', data: { summary: 1 } }],
        'user',
      );

      expect(records(malformed, { summary })).toEqual([]);
    });
  });

  it('ignores unsupported parts', () => {
    expect(
      records(msg([{ type: 'step-start' }, { type: 'file', url: 'x' }]), {
        text: { roles: ['assistant'], limit: LIMIT },
      }),
    ).toEqual([]);
  });
});
