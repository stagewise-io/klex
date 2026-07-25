import { convertToModelMessages } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/types';

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

function makeHistorySummaryPart(
  summary: string,
): ExtendedUIMessage['parts'][number] {
  return {
    type: 'data-history-summary',
    data: { summary },
  } as ExtendedUIMessage['parts'][number];
}

function makeContinuePart(): ExtendedUIMessage['parts'][number] {
  return {
    type: 'data-continue',
    data: {},
  } as ExtendedUIMessage['parts'][number];
}

// --- tests ---

describe('convertToModelMessagesExtended', () => {
  it('delegates to convertToModelMessages with the messages', async () => {
    const messages = [makeMessage([{ type: 'text', text: 'hello' }])];
    await convertToModelMessagesExtended(messages);
    expect(convertToModelMessages).toHaveBeenCalledWith(messages, {
      convertDataPart: expect.any(Function),
    });
  });

  it('returns the converted model messages', async () => {
    const messages = [makeMessage([{ type: 'text', text: 'hello' }])];
    vi.mocked(convertToModelMessages).mockResolvedValue([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ] as never);
    const result = await convertToModelMessagesExtended(messages);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });
});

describe('convertCustomDataParts — data-context', () => {
  function getConvertDataPart() {
    const calls = vi.mocked(convertToModelMessages).mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[1]?.convertDataPart as (
      part: ExtendedUIMessage['parts'][number],
    ) => unknown;
  }

  it('converts data-context to XML text with sourceEnv, metadata, and content', async () => {
    const messages = [
      makeMessage([
        makeContextPart('slack', { channel: 'general', priority: 1 }, [
          { type: 'text', text: 'hello' },
        ]),
      ]),
    ];
    await convertToModelMessagesExtended(messages);
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
    await convertToModelMessagesExtended(messages);
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
    await convertToModelMessagesExtended(messages);
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
    await convertToModelMessagesExtended(messages);
    const convert = getConvertDataPart();
    const result = convert(makeContextPart('media', {}, [imageContent])) as {
      type: string;
      text: string;
    };

    // Non-text content parts are currently dropped to empty string
    expect(result.text).toContain('<content></content>');
  });
});

describe('convertCustomDataParts — data-history-summary', () => {
  function getConvertDataPart() {
    const calls = vi.mocked(convertToModelMessages).mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[1]?.convertDataPart as (
      part: ExtendedUIMessage['parts'][number],
    ) => unknown;
  }

  it('converts data-history-summary to XML text with summary tag', async () => {
    const messages = [
      makeMessage([makeHistorySummaryPart('Earlier conversation about X')]),
    ];
    await convertToModelMessagesExtended(messages);
    const convert = getConvertDataPart();
    const result = convert(
      makeHistorySummaryPart('Earlier conversation about X'),
    ) as { type: string; text: string };

    expect(result.type).toBe('text');
    expect(result.text).toBe('<summary>Earlier conversation about X</summary>');
  });
});

describe('convertCustomDataParts — data-continue', () => {
  function getConvertDataPart() {
    const calls = vi.mocked(convertToModelMessages).mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[1]?.convertDataPart as (
      part: ExtendedUIMessage['parts'][number],
    ) => unknown;
  }

  it('converts data-continue to text part with content "Continue."', async () => {
    const messages = [makeMessage([makeContinuePart()])];
    await convertToModelMessagesExtended(messages);
    const convert = getConvertDataPart();
    const result = convert(makeContinuePart()) as {
      type: string;
      text: string;
    };

    expect(result.type).toBe('text');
    expect(result.text).toBe('Continue.');
  });
});

describe('convertCustomDataParts — unknown part types', () => {
  function getConvertDataPart() {
    const calls = vi.mocked(convertToModelMessages).mock.calls;
    const lastCall = calls[calls.length - 1];
    return lastCall?.[1]?.convertDataPart as (
      part: ExtendedUIMessage['parts'][number],
    ) => unknown;
  }

  it('returns undefined for unrecognized data part types', async () => {
    const messages = [
      makeMessage([{ type: 'data-unknown', data: {} } as never]),
    ];
    await convertToModelMessagesExtended(messages);
    const convert = getConvertDataPart();
    const result = convert({ type: 'data-unknown', data: {} } as never);
    expect(result).toBeUndefined();
  });
});
