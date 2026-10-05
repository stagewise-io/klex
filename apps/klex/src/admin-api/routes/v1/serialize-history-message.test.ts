import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { serializeHistoryMessage } from './serialize-history-message';

function toolMessage(output: unknown): ExtendedUIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-fetch',
        toolCallId: 't1',
        state: 'output-available',
        input: {},
        output,
      },
    ],
  } as unknown as ExtendedUIMessage;
}

function serializedOutput(output: unknown): unknown {
  const [part] = serializeHistoryMessage(toolMessage(output), {
    includeProviderMetadata: false,
  }).parts;
  return part?.output;
}

describe('serializeHistoryMessage', () => {
  it('redacts data URLs in any encoding', () => {
    expect(
      serializedOutput({
        base64: 'data:image/png;base64,AAAA',
        percent: 'data:image/svg+xml,%3Csvg%3E',
        spaced: 'data:text/plain,raw text with spaces',
      }),
    ).toEqual({
      base64: 'data:image/png;base64,[redacted, 4 bytes]',
      percent: 'data:image/svg+xml,[redacted, 9 bytes]',
      spaced: 'data:text/plain,[redacted, 20 bytes]',
    });
  });

  it('redacts data URLs embedded in free-form text', () => {
    expect(
      serializedOutput(
        'see <img src="data:image/png;base64,AAAAAAAA"> and data:,x then metadata: kept',
      ),
    ).toBe(
      'see <img src="data:image/png;base64,[redacted, 8 bytes]"> and data:,[redacted, 1 bytes] then metadata: kept',
    );
  });

  it('leaves prose that starts with "data:" untouched', () => {
    expect(serializedOutput('data: 3 rows, 2 columns')).toBe(
      'data: 3 rows, 2 columns',
    );
  });

  it('replaces subtrees beyond the depth limit instead of exposing them', () => {
    let nested: unknown = { type: 'image', data: 'AAAA' };
    for (let depth = 0; depth < 80; depth++) nested = { child: nested };
    expect(JSON.stringify(serializedOutput(nested))).not.toContain('AAAA');
    expect(JSON.stringify(serializedOutput(nested))).toContain(
      '[redacted, maximum depth exceeded]',
    );
  });

  it('preserves own __proto__ keys from stored payloads', () => {
    const output: unknown = JSON.parse('{"__proto__":{"kept":true},"a":1}');
    const result = serializedOutput(output);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(result))).toEqual(
      JSON.parse('{"__proto__":{"kept":true},"a":1}'),
    );
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true);
  });
});
