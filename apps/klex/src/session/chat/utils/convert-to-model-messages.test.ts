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
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
  )[],
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
  } as unknown as ExtendedUIMessage['parts'][number];
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

describe('data-context materialization', () => {
  const image = {
    type: 'image' as const,
    mimeType: 'image/png',
    data: 'aW1hZ2U=',
  };

  it('materializes escaped metadata and ordered text around a native image', async () => {
    const context = makeContextPart('telegram<&', { channel: 'a"b' }, [
      { type: 'text', text: 'caption <first>' },
      image,
      { type: 'text', text: 'after & last' },
    ]);
    const messages = [makeMessage([context])];
    const original = structuredClone(messages);

    await convertToModelMessagesExtended(messages, makeTransformers(), {
      inputCapabilities: {
        image: { mediaTypes: ['image/png'], maxBytes: 100 },
      },
    });

    const materialized = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0];
    expect(materialized?.[0]?.parts).toEqual([
      {
        type: 'text',
        text: '<context source-env="telegram&lt;&amp;"><metadata><item key="channel" value="a&quot;b" /></metadata><content>',
      },
      { type: 'text', text: 'caption &lt;first&gt;' },
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,aW1hZ2U=',
      },
      { type: 'text', text: 'after &amp; last' },
      { type: 'text', text: '</content></context>' },
    ]);
    expect(messages).toEqual(original);
  });

  it('uses an explicit placeholder for a text-only model', async () => {
    await convertToModelMessagesExtended(
      [makeMessage([makeContextPart('media', {}, [image])])],
      makeTransformers(),
      { inputCapabilities: {} },
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'text',
      text: '<unsupported-image mime-type="image/png" bytes="5" reason="model-does-not-support-images" />',
    });
    expect(JSON.stringify(parts)).not.toContain(image.data);
  });

  it.each([
    {
      capability: { mediaTypes: ['image/jpeg'], maxBytes: 100 },
      expectedReason: 'unsupported-media-type',
    },
    {
      capability: { mediaTypes: ['image/png'], maxBytes: 4 },
      expectedReason: 'too-large',
    },
  ])(
    'degrades images outside selected-model constraints',
    async ({ capability, expectedReason }) => {
      await convertToModelMessagesExtended(
        [makeMessage([makeContextPart('media', {}, [image])])],
        makeTransformers(),
        { inputCapabilities: { image: capability } },
      );

      const parts = vi
        .mocked(convertToModelMessages)
        .mock.calls.at(-1)?.[0][0]?.parts;
      expect(JSON.stringify(parts)).toContain(`reason=\\"${expectedReason}\\"`);
      expect(JSON.stringify(parts)).not.toContain(image.data);
    },
  );

  it('defensively degrades malformed image data', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('media', {}, [
            { ...image, data: 'not valid base64!' },
          ]),
        ]),
      ],
      makeTransformers(),
      {
        inputCapabilities: {
          image: { mediaTypes: ['image/png'], maxBytes: 100 },
        },
      },
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(JSON.stringify(parts)).toContain('invalid-base64');
    expect(JSON.stringify(parts)).not.toContain('not valid base64!');
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
    const contextTransformer = vi.fn(() => [
      { type: 'text', text: 'OVERRIDDEN' },
    ]);
    const transformers = {
      context: contextTransformer,
    } as unknown as DataPartTransformers;
    await convertToModelMessagesExtended(messages, transformers);

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('<context source-env="slack">'),
    });
    expect(contextTransformer).not.toHaveBeenCalled();
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
