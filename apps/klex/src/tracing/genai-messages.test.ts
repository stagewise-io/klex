import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  type GenAiMessage,
  serializeMessagesWithBudget,
  serializePartsWithBudget,
  toGenAiInputMessages,
  toGenAiOutputMessages,
  toGenAiOutputMessagesFromSteps,
  toGenAiPart,
  toGenAiSystemInstructions,
} from './genai-messages';

describe('toGenAiPart', () => {
  it('maps text, reasoning, tool calls, and tool results', () => {
    expect(toGenAiPart({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      content: 'hi',
    });
    expect(toGenAiPart({ type: 'reasoning', text: 'think' })).toEqual({
      type: 'reasoning',
      content: 'think',
    });
    expect(
      toGenAiPart({
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'search',
        input: { q: 'x' },
      }),
    ).toEqual({
      type: 'tool_call',
      id: 'c1',
      name: 'search',
      arguments: { q: 'x' },
    });
    expect(
      toGenAiPart({
        type: 'tool-error',
        toolCallId: 'c2',
        toolName: 'search',
        error: new TypeError('bad'),
      }),
    ).toEqual({
      type: 'tool_call_response',
      id: 'c2',
      response: 'TypeError: bad',
    });
  });

  it.each([
    [{ type: 'text', value: 'ok' }, 'ok'],
    [{ type: 'error-text', value: 'failed' }, 'failed'],
    [{ type: 'json', value: { n: 1 } }, { n: 1 }],
    [{ type: 'error-json', value: { code: 2 } }, { code: 2 }],
    [{ type: 'execution-denied', reason: 'no' }, 'Execution denied: no'],
    [{ type: 'execution-denied' }, 'Execution denied'],
    [
      {
        type: 'content',
        value: [
          { type: 'text', text: 'see image' },
          { type: 'file-data', data: 'AAAA', mediaType: 'image/png' },
        ],
      },
      [
        { type: 'text', content: 'see image' },
        { type: 'blob', modality: 'image', mime_type: 'image/png' },
      ],
    ],
  ])('maps tool result output %j', (output, response) => {
    expect(
      toGenAiPart({
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'search',
        output,
      }),
    ).toEqual({ type: 'tool_call_response', id: 'c1', response });
  });

  it('exports files and images without bytes', () => {
    expect(
      toGenAiPart({ type: 'file', data: 'AAAA', mediaType: 'application/pdf' }),
    ).toEqual({
      type: 'blob',
      modality: 'application',
      mime_type: 'application/pdf',
    });
    expect(
      toGenAiPart({ type: 'image', image: 'AAAA', mediaType: 'image/jpeg' }),
    ).toEqual({ type: 'blob', modality: 'image', mime_type: 'image/jpeg' });
    expect(
      toGenAiPart({
        type: 'file',
        file: { mediaType: 'image/png', base64: 'AAAA' },
      }),
    ).toEqual({ type: 'blob', modality: 'image', mime_type: 'image/png' });
  });

  it('keeps only the type of unknown parts', () => {
    expect(
      toGenAiPart({
        type: 'tool-approval-request',
        approvalId: 'a',
        secret: 1,
      }),
    ).toEqual({ type: 'tool-approval-request' });
  });
});

describe('message conversion', () => {
  it('converts the probe conversation to the GenAI semconv shape', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'What is the weather in Berlin?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'Berlin' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            output: { type: 'json', value: { tempC: 21 } },
          },
        ],
      },
    ];

    expect(toGenAiInputMessages(messages)).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'What is the weather in Berlin?' }],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'Let me check.' },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { city: 'Berlin' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_call_response', id: 'call_1', response: { tempC: 21 } },
        ],
      },
    ]);
    expect(
      toGenAiOutputMessages([{ type: 'text', text: 'It is 21°C.' }], 'stop'),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'It is 21°C.' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('marks the last aborted step', () => {
    const result = toGenAiOutputMessagesFromSteps([
      { content: [{ type: 'text', text: 'a' }] },
      { content: [{ type: 'text', text: 'b' }] },
    ]);
    expect(result[0]?.finish_reason).toBeUndefined();
    expect(result[1]?.finish_reason).toBe('aborted');
  });

  it('converts system instructions to text parts', () => {
    expect(toGenAiSystemInstructions('be nice')).toEqual([
      { type: 'text', content: 'be nice' },
    ]);
    expect(
      toGenAiSystemInstructions([
        { role: 'system', content: 'one' },
        { role: 'system', content: 'two' },
      ]),
    ).toEqual([
      { type: 'text', content: 'one' },
      { type: 'text', content: 'two' },
    ]);
    expect(toGenAiSystemInstructions(undefined)).toBeUndefined();
  });
});

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function textMessage(content: string): GenAiMessage {
  return { role: 'user', parts: [{ type: 'text', content }] };
}

describe('budgeted serialization', () => {
  it('keeps everything within budget', () => {
    const result = serializeMessagesWithBudget([textMessage('a')], 1_000);
    expect(result).toEqual({
      json: JSON.stringify([textMessage('a')]),
      droppedMessages: 0,
      truncated: false,
    });
  });

  it('drops the oldest messages and keeps the last one', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      textMessage(`${index}`.padEnd(100, 'x')),
    );
    const result = defined(serializeMessagesWithBudget(messages, 500));
    const parsed = JSON.parse(result.json) as GenAiMessage[];
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(500);
    expect(result.droppedMessages).toBe(10 - parsed.length);
    expect(parsed.at(-1)).toEqual(messages.at(-1));
    expect(result.truncated).toBe(false);
  });

  it('truncates the last message payload when it alone exceeds the budget', () => {
    const result = defined(
      serializeMessagesWithBudget(
        [textMessage('a'), textMessage('é'.repeat(5_000))],
        1_000,
      ),
    );
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1_000);
    expect(result.droppedMessages).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.json).toContain('…[truncated]');
    expect(() => JSON.parse(result.json)).not.toThrow();
  });

  it('truncates non-string tool payloads as JSON text', () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const result = defined(
      serializeMessagesWithBudget(
        [
          {
            role: 'tool',
            parts: [{ type: 'tool_call_response', id: 'c', response: big }],
          },
        ],
        1_000,
      ),
    );
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(1_000);
    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.json) as GenAiMessage[];
    const part = parsed[0]?.parts[0] as { id: string; response: unknown };
    expect(part.id).toBe('c');
    expect(typeof part.response).toBe('string');
  });

  it('truncates system instruction parts', () => {
    const result = defined(
      serializePartsWithBudget(
        [{ type: 'text', content: 'x'.repeat(2_000) }],
        500,
      ),
    );
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
  });
});
