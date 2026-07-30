import { convertToModelMessages } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { convertToModelMessagesExtended } from './convert-to-model-messages';

// --- mocks ---

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    convertToModelMessages: vi.fn(
      (messages: ExtendedUIMessage[]) => messages as never,
    ),
  };
});

// --- fixtures ---

function makeMessage(
  parts: ExtendedUIMessage['parts'],
  role: 'user' | 'assistant' = 'user',
): ExtendedUIMessage {
  return {
    id: 'msg-1',
    role,
    parts,
  } as ExtendedUIMessage;
}

function makeContextPart(
  sourceEnv: string,
  metadata: Record<string, string | number | boolean>,
  content: { type: 'text'; text: string }[],
): ExtendedUIMessage['parts'][number] {
  return {
    type: 'data-context',
    data: { sourceEnv, metadata, content },
  } as ExtendedUIMessage['parts'][number];
}

function makeContextSummaryPart(
  summary: string,
): ExtendedUIMessage['parts'][number] {
  return {
    type: 'data-context-summary',
    data: { summary },
  } as ExtendedUIMessage['parts'][number];
}

function makeContinuePart(): ExtendedUIMessage['parts'][number] {
  return {
    type: 'data-continue',
    data: {},
  } as ExtendedUIMessage['parts'][number];
}

// --- transformer fixtures ---

/**
 * Empty transformer map for tests that only exercise core types
 * (`context`, `continue`) or message filtering. Core types are
 * handled by built-in transformers and never touch this map.
 */
function makeTransformers(): DataPartTransformers {
  return {} as DataPartTransformers;
}

function getConvertDataPart() {
  const calls = vi.mocked(convertToModelMessages).mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall?.[1]?.convertDataPart as (
    part: ExtendedUIMessage['parts'][number],
  ) => unknown;
}

// --- tests ---

describe('convertToModelMessagesExtended', () => {
  it('delegates to convertToModelMessages with the messages and transformers', async () => {
    const messages = [makeMessage([{ type: 'text', text: 'hello' }])];
    const transformers = makeTransformers();
    await convertToModelMessagesExtended(messages, transformers);
    expect(convertToModelMessages).toHaveBeenCalledWith(messages, {
      convertDataPart: expect.any(Function),
    });
  });

  it('returns the converted model messages', async () => {
    const messages = [makeMessage([{ type: 'text', text: 'hello' }])];
    vi.mocked(convertToModelMessages).mockResolvedValue([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ] as never);
    const result = await convertToModelMessagesExtended(
      messages,
      makeTransformers(),
    );
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });
});

describe('makeConvertDataPart — data-context', () => {
  it('converts data-context to XML text with sourceEnv, metadata, and content', async () => {
    const messages = [
      makeMessage([
        makeContextPart('slack', { channel: 'general', priority: 1 }, [
          { type: 'text', text: 'hello' },
        ]),
      ]),
    ];
    await convertToModelMessagesExtended(messages, makeTransformers());
    const convert = getConvertDataPart();
    const result = convert(
      makeContextPart('slack', { channel: 'general', priority: 1 }, [
        { type: 'text', text: 'hello' },
      ]),
    ) as { type: string; text: string };

    expect(result.type).toBe('text');
    expect(result.text).toContain('<context source-env="slack">');
    expect(result.text).toContain('<metadata>');
    expect(result.text).toContain('channel');
    expect(result.text).toContain('general');
    expect(result.text).toContain('priority');
    expect(result.text).toContain('1');
    expect(result.text).toContain('<content>hello</content>');
    expect(result.text).toContain('</context>');
  });

  it('joins multiple text content parts with spaces', async () => {
    const messages = [
      makeMessage([
        makeContextPart('email', {}, [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ]),
      ]),
    ];
    await convertToModelMessagesExtended(messages, makeTransformers());
    const convert = getConvertDataPart();
    const result = convert(
      makeContextPart('email', {}, [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ) as { type: string; text: string };

    expect(result.text).toContain('<content>first second</content>');
  });

  it('serializes boolean metadata values', async () => {
    const messages = [
      makeMessage([
        makeContextPart('webhook', { urgent: true }, [
          { type: 'text', text: 'alert' },
        ]),
      ]),
    ];
    await convertToModelMessagesExtended(messages, makeTransformers());
    const convert = getConvertDataPart();
    const result = convert(
      makeContextPart('webhook', { urgent: true }, [
        { type: 'text', text: 'alert' },
      ]),
    ) as { type: string; text: string };

    expect(result.text).toContain('urgent');
    expect(result.text).toContain('true');
  });

  it('returns empty string for non-text content parts', async () => {
    const imageContent = {
      type: 'image',
      mimeType: 'image/png',
      url: 'https://example.com/img.png',
    } as unknown as { type: 'text'; text: string };
    const messages = [
      makeMessage([makeContextPart('media', {}, [imageContent])]),
    ];
    await convertToModelMessagesExtended(messages, makeTransformers());
    const convert = getConvertDataPart();
    const result = convert(makeContextPart('media', {}, [imageContent])) as {
      type: string;
      text: string;
    };

    // Non-text content parts are currently dropped to empty string
    expect(result.text).toContain('<content></content>');
  });
});

describe('makeConvertDataPart — non-core dispatch', () => {
  it('dispatches non-core data parts to extension-registered transformers', async () => {
    const transformer = vi.fn((data: { summary: string }) => [
      { type: 'text', text: `DISPATCHED:${data.summary}` },
    ]);
    const transformers = {
      'context-summary': transformer,
    } as unknown as DataPartTransformers;
    const messages = [makeMessage([makeContextSummaryPart('test summary')])];
    await convertToModelMessagesExtended(messages, transformers);
    const convert = getConvertDataPart();
    const result = convert(makeContextSummaryPart('test summary')) as {
      type: string;
      text: string;
    };

    expect(transformer).toHaveBeenCalledOnce();
    expect(transformer).toHaveBeenCalledWith({ summary: 'test summary' });
    expect(result).toEqual({ type: 'text', text: 'DISPATCHED:test summary' });
  });
});

describe('makeConvertDataPart — data-continue', () => {
  it('converts data-continue to text part with content "Continue."', async () => {
    const messages = [makeMessage([makeContinuePart()])];
    await convertToModelMessagesExtended(messages, makeTransformers());
    const convert = getConvertDataPart();
    const result = convert(makeContinuePart()) as {
      type: string;
      text: string;
    };

    expect(result.type).toBe('text');
    expect(result.text).toBe('Continue.');
  });
});

describe('makeConvertDataPart — core type override prevention', () => {
  it('ignores extension-registered context transformer and uses built-in', async () => {
    const messages = [
      makeMessage([
        makeContextPart('slack', { channel: 'general' }, [
          { type: 'text', text: 'hello' },
        ]),
      ]),
    ];
    // Extension tries to register a transformer for `context` — must be ignored.
    const transformers = {
      context: () => [{ type: 'text', text: 'OVERRIDDEN' }],
    } as unknown as DataPartTransformers;
    await convertToModelMessagesExtended(messages, transformers);
    const convert = getConvertDataPart();
    const result = convert(
      makeContextPart('slack', { channel: 'general' }, [
        { type: 'text', text: 'hello' },
      ]),
    ) as { type: string; text: string };

    expect(result.text).toContain('<context source-env="slack">');
    expect(result.text).not.toBe('OVERRIDDEN');
  });

  it('ignores extension-registered continue transformer and uses built-in', async () => {
    const messages = [makeMessage([makeContinuePart()])];
    // Extension tries to register a transformer for `continue` — must be ignored.
    const transformers = {
      continue: () => [{ type: 'text', text: 'OVERRIDDEN' }],
    } as unknown as DataPartTransformers;
    await convertToModelMessagesExtended(messages, transformers);
    const convert = getConvertDataPart();
    const result = convert(makeContinuePart()) as {
      type: string;
      text: string;
    };

    expect(result.text).toBe('Continue.');
    expect(result.text).not.toBe('OVERRIDDEN');
  });
});

describe('convertToModelMessagesExtended — data-continue filtering', () => {
  it('strips data-continue from older user messages but preserves in last when preceded by assistant text-only', async () => {
    const messages = [
      makeMessage([makeContinuePart(), { type: 'text', text: 'earlier' }]),
      makeMessage([{ type: 'text', text: 'assistant response' }], 'assistant'),
      makeMessage([makeContinuePart(), { type: 'text', text: 'real input' }]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // All 3 messages preserved — no merging or dropping
    expect(passedMessages).toHaveLength(3);
    // First user message: data-continue stripped, text part remains
    expect(
      passedMessages[0]?.parts.some((p) => p.type === 'data-continue'),
    ).toBe(false);
    expect(passedMessages[0]?.parts.some((p) => p.type === 'text')).toBe(true);
    // Assistant message: unchanged
    expect(passedMessages[1]?.role).toBe('assistant');
    // Last user message: data-continue preserved
    expect(
      passedMessages[2]?.parts.some((p) => p.type === 'data-continue'),
    ).toBe(true);
  });

  it('keeps multiple older user messages separate after stripping', async () => {
    const messages = [
      makeMessage([makeContinuePart(), { type: 'text', text: 'first' }]),
      makeMessage([makeContinuePart(), { type: 'text', text: 'second' }]),
      makeMessage([makeContinuePart(), { type: 'text', text: 'third' }]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // All 3 messages preserved as separate messages
    expect(passedMessages).toHaveLength(3);
    // Continue is stripped from all — no assistant message precedes the last
    expect(passedMessages[0]?.parts).toEqual([{ type: 'text', text: 'first' }]);
    expect(passedMessages[1]?.parts).toEqual([
      { type: 'text', text: 'second' },
    ]);
    expect(passedMessages[2]?.parts).toEqual([{ type: 'text', text: 'third' }]);
  });

  it('preserves all parts when no data-continue parts exist', async () => {
    const messages = [
      makeMessage([{ type: 'text', text: 'hello' }]),
      makeMessage([{ type: 'text', text: 'response' }], 'assistant'),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    expect(passedMessages[0]?.parts).toHaveLength(1);
    expect(passedMessages[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: 'hello',
    });
  });

  it('preserves data-continue when last message is assistant without tool calls', async () => {
    const messages = [
      makeMessage([{ type: 'text', text: 'earlier' }]),
      makeMessage([{ type: 'text', text: 'response' }], 'assistant'),
      makeMessage([makeContinuePart()]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // Last user message keeps its data-continue (preceding is assistant text-only)
    expect(
      passedMessages[2]?.parts.some((p) => p.type === 'data-continue'),
    ).toBe(true);
  });

  it('leaves messages untouched when there are no user messages', async () => {
    const messages = [
      makeMessage([{ type: 'text', text: 'response' }], 'assistant'),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    expect(passedMessages).toHaveLength(1);
    expect(passedMessages[0]?.parts).toHaveLength(1);
  });

  it('drops user messages that become empty after continue stripping', async () => {
    const messages = [
      makeMessage([makeContinuePart()]),
      makeMessage([{ type: 'text', text: 'response' }], 'assistant'),
      makeMessage([makeContinuePart()]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // First user message had only a data-continue part — dropped entirely.
    // Last user message keeps its data-continue.
    expect(passedMessages).toHaveLength(2);
    expect(passedMessages[0]?.role).toBe('assistant');
    expect(
      passedMessages[1]?.parts.some((p) => p.type === 'data-continue'),
    ).toBe(true);
  });

  it('strips data-continue from all user messages when no assistant precedes', async () => {
    const messages = [
      makeMessage([makeContinuePart(), { type: 'text', text: 'real text' }]),
      makeMessage([makeContinuePart()]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // First user message: continue stripped, text part remains
    expect(passedMessages[0]?.parts).toHaveLength(1);
    expect(passedMessages[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: 'real text',
    });
    // Last user message: only had continue — dropped entirely
    expect(passedMessages).toHaveLength(1);
  });

  it('strips data-continue when preceding assistant has tool calls', async () => {
    const messages = [
      makeMessage([{ type: 'text', text: 'do something' }]),
      makeMessage(
        [
          { type: 'text', text: 'calling tool' },
          {
            type: 'tool-someTool' as never,
            toolCallId: 'call-1',
            state: 'input-available',
            input: {},
            providerExecuted: false,
          } as never,
        ],
        'assistant',
      ),
      makeMessage([makeContinuePart()]),
    ];

    await convertToModelMessagesExtended(messages, makeTransformers());

    const passedMessages = vi.mocked(convertToModelMessages).mock.calls[
      vi.mocked(convertToModelMessages).mock.calls.length - 1
    ]?.[0] as ExtendedUIMessage[];

    // Continue is stripped from last user message because preceding assistant
    // has tool calls — tool results prompt continuation naturally.
    // The last user message had only Continue, so it's dropped entirely.
    expect(passedMessages).toHaveLength(2);
    expect(passedMessages[1]?.role).toBe('assistant');
    expect(
      passedMessages.some((m) =>
        m.parts.some((p) => p.type === 'data-continue'),
      ),
    ).toBe(false);
  });
});

describe('makeConvertDataPart — unregistered part types', () => {
  it('returns undefined for part types with no registered transformer', async () => {
    const messages = [
      makeMessage([{ type: 'data-unknown', data: {} } as never]),
    ];
    // Empty transformers — no type is registered
    await convertToModelMessagesExtended(messages, {});
    const convert = getConvertDataPart();
    const result = convert({ type: 'data-unknown', data: {} } as never);
    expect(result).toBeUndefined();
  });
});
