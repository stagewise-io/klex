import { convertToModelMessages } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { convertToModelMessagesExtended } from './convert-to-model-messages';

// --- helpers ---

/** Mirrors the converter's escapeXmlText for element-text expectations. */
function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

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
    | { type: 'audio'; mimeType: string; data: string }
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
        size?: number;
      }
    | {
        type: 'resource';
        resource: {
          uri: string;
          mimeType?: string;
          text?: string;
          blob?: string;
        };
      }
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
  const audio = {
    type: 'audio' as const,
    mimeType: 'audio/ogg',
    data: 'YXVkaW8=',
  };

  it('materializes escaped metadata and ordered text around native media', async () => {
    const context = makeContextPart('telegram<&', { channel: 'a"b' }, [
      { type: 'text', text: 'caption <first>' },
      image,
      audio,
      { type: 'text', text: 'after & last' },
    ]);
    const messages = [makeMessage([context])];
    const original = structuredClone(messages);

    await convertToModelMessagesExtended(messages, makeTransformers());

    const materialized = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0];
    // Metadata is now an XML-escaped JSON dump
    const expectedMetadata = escapeXmlText(JSON.stringify({ channel: 'a"b' }));
    expect(materialized?.[0]?.parts).toEqual([
      {
        type: 'text',
        text: `<context source-env="telegram&lt;&amp;"><metadata>${expectedMetadata}</metadata><content>`,
      },
      { type: 'text', text: '<text>caption &lt;first&gt;</text>' },
      { type: 'text', text: '<image>' },
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,aW1hZ2U=',
      },
      { type: 'text', text: '</image>' },
      { type: 'text', text: '<audio>' },
      {
        type: 'file',
        mediaType: 'audio/ogg',
        url: 'data:audio/ogg;base64,YXVkaW8=',
      },
      { type: 'text', text: '</audio>' },
      { type: 'text', text: '<text>after &amp; last</text>' },
      { type: 'text', text: '</content></context>' },
    ]);
    expect(messages).toEqual(original);
  });

  it('emits a canonical lowercase MIME type for images', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('media', {}, [{ ...image, mimeType: 'IMAGE/PNG' }]),
        ]),
      ],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,aW1hZ2U=',
    });
  });

  it('emits a canonical lowercase MIME type for audio', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('media', {}, [{ ...audio, mimeType: 'AUDIO/OGG' }]),
        ]),
      ],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'audio/ogg',
      url: 'data:audio/ogg;base64,YXVkaW8=',
    });
  });

  it('passes image data through regardless of model capabilities', async () => {
    // The converter no longer gates images by model capabilities —
    // the VisionInputOptimizer extension handles unsupported models,
    // format conversion, and resizing at Stage 4.
    await convertToModelMessagesExtended(
      [makeMessage([makeContextPart('media', {}, [image])])],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,aW1hZ2U=',
    });
  });

  it('passes audio through regardless of model capabilities', async () => {
    await convertToModelMessagesExtended(
      [makeMessage([makeContextPart('media', {}, [audio])])],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'audio/ogg',
      url: 'data:audio/ogg;base64,YXVkaW8=',
    });
  });

  it('passes malformed audio through without validation', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('media', {}, [
            { ...audio, data: 'not valid base64!' },
          ]),
        ]),
      ],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'audio/ogg',
      url: 'data:audio/ogg;base64,not valid base64!',
    });
  });

  it('materializes embedded binary resources as normalized file parts', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('slack', {}, [
            { type: 'text', text: 'document' },
            {
              type: 'resource',
              resource: {
                uri: 'slack://T1/files/F1',
                mimeType: ' APPLICATION/PDF ',
                blob: 'ZG9j\n',
              },
            },
            image,
            audio,
          ]),
        ]),
      ],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'application/pdf',
      url: 'data:application/pdf;base64,ZG9j',
    });
    expect(parts?.findIndex((part) => part.type === 'file')).toBeLessThan(
      parts?.findLastIndex((part) => part.type === 'file') ?? 0,
    );
  });

  it.each([undefined, '   '])(
    'retains a textual fallback for blobs with MIME type %s',
    async (mimeType) => {
      await convertToModelMessagesExtended(
        [
          makeMessage([
            makeContextPart('slack', {}, [
              {
                type: 'resource',
                resource: {
                  uri: 'slack://T1/files/F1',
                  ...(mimeType === undefined ? {} : { mimeType }),
                  blob: 'aGVsbG8<&',
                },
              },
            ]),
          ]),
        ],
        makeTransformers(),
      );

      const parts = vi
        .mocked(convertToModelMessages)
        .mock.calls.at(-1)?.[0][0]?.parts;
      expect(parts).toContainEqual({
        type: 'text',
        text: '<blob>aGVsbG8&lt;&amp;</blob>',
      });
    },
  );

  it('passes image data through as a file part without validation', async () => {
    await convertToModelMessagesExtended(
      [
        makeMessage([
          makeContextPart('media', {}, [
            { ...image, data: 'not valid base64!' },
          ]),
        ]),
      ],
      makeTransformers(),
    );

    const parts = vi
      .mocked(convertToModelMessages)
      .mock.calls.at(-1)?.[0][0]?.parts;
    expect(parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,not valid base64!',
    });
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
