import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { serializeMessages } from './serialize-messages';

function getPart(
  messages: ReturnType<typeof serializeMessages>,
  messageIndex = 0,
  partIndex = 0,
) {
  const part = messages[messageIndex]?.parts[partIndex];
  if (!part) throw new Error('Expected serialized message part');
  return part;
}

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  parts: ExtendedUIMessage['parts'],
): ExtendedUIMessage {
  return {
    id,
    role,
    parts,
  } as unknown as ExtendedUIMessage;
}

describe('serializeMessages', () => {
  it('serializes text parts', () => {
    const messages = [
      makeMessage('m1', 'user', [{ type: 'text', text: 'hello' }]),
    ];
    const result = serializeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('m1');
    expect(result[0]?.role).toBe('user');
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('serializes reasoning parts', () => {
    const messages = [
      makeMessage('m1', 'assistant', [
        { type: 'reasoning', text: 'thinking...' } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    expect(result[0]?.parts[0]).toEqual({
      type: 'reasoning',
      text: 'thinking...',
    });
  });

  it('normalizes dynamic tool parts and truncates long input', () => {
    const longInput = { key: 'x'.repeat(200) };
    const messages = [
      makeMessage('m1', 'assistant', [
        {
          type: 'tool-myTool',
          toolCallId: 'call-1',
          state: 'input-available',
          input: longInput,
          providerExecuted: false,
        } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    const part = getPart(result);
    expect(part.type).toBe('tool-invocation');
    expect((part as unknown as { toolName: string }).toolName).toBe('myTool');
    expect((part as unknown as { state: string }).state).toBe(
      'input-available',
    );
    const args = (part as unknown as { args: string }).args;
    expect(typeof args).toBe('string');
    expect(args.endsWith('...')).toBe(true);
    expect(args.length).toBeLessThanOrEqual(104);
  });

  it('normalizes dynamic tool output and truncates the result', () => {
    const longResult = { data: 'y'.repeat(200) };
    const messages = [
      makeMessage('m1', 'assistant', [
        {
          type: 'tool-myTool',
          toolCallId: 'call-2',
          state: 'output-available',
          input: {},
          output: longResult,
          providerExecuted: false,
        } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    const part = getPart(result);
    expect((part as unknown as { state: string }).state).toBe(
      'output-available',
    );
    const resultStr = (part as unknown as { result: string }).result;
    expect(typeof resultStr).toBe('string');
    expect(resultStr.endsWith('...')).toBe(true);
  });

  it('normalizes dynamic tool errors', () => {
    const result = serializeMessages([
      makeMessage('m1', 'assistant', [
        {
          type: 'tool-updateSoul',
          toolCallId: 'call-3',
          state: 'output-error',
          input: { content: 'new soul' },
          errorText: 'write failed',
          providerExecuted: false,
        } as never,
      ]),
    ]);

    expect(getPart(result)).toMatchObject({
      type: 'tool-invocation',
      toolName: 'updateSoul',
      state: 'output-error',
      args: { content: 'new soul' },
      result: { error: 'write failed' },
    });
  });

  it('serializes data-god-message parts and redacts image base64 data', () => {
    const messages = [
      makeMessage('m1', 'user', [
        {
          type: 'data-god-message',
          data: {
            content: [
              { type: 'text', text: 'Look at this' },
              { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            ],
          },
        } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    const part = getPart(result);
    expect(part.type).toBe('data-god-message');
    const content = (
      part as unknown as {
        data: { content: Array<{ type: string; data?: string }> };
      }
    ).data.content;
    expect(content[0]).toEqual({ type: 'text', text: 'Look at this' });
    expect(content[1]?.data).toBe('[redacted, 12 bytes]');
  });

  it('serializes data-context parts and redacts audio base64 data', () => {
    const messages = [
      makeMessage('m1', 'user', [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'test',
            metadata: {},
            content: [
              { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQ=' },
            ],
          },
        } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    const part = getPart(result);
    expect(part.type).toBe('data-context');
    const content = (
      part as unknown as {
        data: { content: Array<{ type: string; data?: string }> };
      }
    ).data.content;
    expect(content[0]?.data).toBe('[redacted, 8 bytes]');
  });

  it('serializes data-continue and data-check parts', () => {
    const messages = [
      makeMessage('m1', 'user', [
        { type: 'data-continue', data: {} } as never,
        { type: 'data-check', data: {} } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    expect(result[0]?.parts[0]).toEqual({ type: 'data-continue', data: {} });
    expect(result[0]?.parts[1]).toEqual({ type: 'data-check', data: {} });
  });

  it('serializes file parts by redacting url and data', () => {
    const messages = [
      makeMessage('m1', 'assistant', [
        { type: 'file', mediaType: 'image/png', url: 'data:...' } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    expect(result[0]?.parts[0]).toEqual({
      type: 'file',
      mediaType: 'image/png',
    });
  });

  it('serializes resource blocks and redacts blob data', () => {
    const messages = [
      makeMessage('m1', 'user', [
        {
          type: 'data-god-message',
          data: {
            content: [
              {
                type: 'resource',
                resource: {
                  uri: 'file:///test',
                  mimeType: 'application/pdf',
                  blob: 'SGVsbG8=',
                },
              },
            ],
          },
        } as never,
      ]),
    ];
    const result = serializeMessages(messages);
    const part = getPart(result);
    const content = (
      part as unknown as {
        data: {
          content: Array<{ type: string; resource?: { blob?: string } }>;
        };
      }
    ).data.content;
    expect(content[0]?.resource?.blob).toBe('[redacted, 8 bytes]');
  });
});
