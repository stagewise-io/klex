import type { ToolResultPart } from 'ai';
import { describe, expect, it } from 'vitest';

import { extractContentOutputText, extractToolResultText } from './tool-result';

function extract(output: ToolResultPart['output']): string {
  return extractToolResultText({
    type: 'tool-result',
    toolCallId: 'call',
    toolName: 'read',
    output,
  });
}

describe('extractToolResultText', () => {
  it.each([
    { content: ['line 1'], total: 1 },
    { content: [{ id: 1 }], page: 2 },
    { content: [{ type: 'paragraph', body: 'x' }] },
    { content: [{ type: 'file', name: 'a.txt' }] },
    { content: [{ type: 'text', text: 'x' }], total: 1 },
    { content: [{ type: 'text', text: 'x', body: 'extra' }] },
    { content: [], isError: 'false' },
    { content: [], _meta: null },
  ])('preserves ordinary JSON %j', (value) => {
    expect(extractContentOutputText(value)).toBeNull();
    for (const type of ['json', 'error-json'] as const) {
      expect(extract({ type, value })).toBe(JSON.stringify(value));
    }
  });

  it('accepts MCP envelope metadata and valid content blocks', () => {
    expect(
      extractContentOutputText({
        content: [
          { type: 'text', text: 'caption', annotations: {} },
          { type: 'image', data: new Uint8Array([1]) },
          { type: 'file', data: new URL('https://example.test/file') },
        ],
        isError: false,
        _meta: {},
      }),
    ).toBe('caption\n[Image attachment: image]\n[File attachment: file]');
  });
  it.each(['json', 'error-json'] as const)(
    'projects nested %s content without signed URLs or inline data',
    (type) => {
      const output = {
        type,
        value: {
          content: [
            { type: 'text', text: 'Screenshot and recording' },
            {
              type: 'image-url',
              url: 'https://example.test/image?token=PRIVATE_TOKEN',
            },
            {
              type: 'file-data',
              mediaType: 'audio/ogg',
              data: 'PRIVATE_PAYLOAD',
            },
            { type: 'text', text: 'Please investigate' },
          ],
        },
      };
      const before = structuredClone(output);
      expect(extract(output)).toBe(
        'Screenshot and recording\n[Image attachment: image-url]\n[Audio attachment: audio/ogg]\nPlease investigate',
      );
      expect(output).toEqual(before);
      expect(extract({ type, value: { content: [] } })).toBe('');
      expect(extract({ type, value: { content: 'ordinary JSON' } })).toBe(
        '{"content":"ordinary JSON"}',
      );
    },
  );
  it.each(['text', 'error-text'] as const)('preserves %s', (type) => {
    expect(extract({ type, value: 'result' })).toBe('result');
  });

  it.each(['json', 'error-json'] as const)('serializes %s', (type) => {
    expect(extract({ type, value: { message: 'failed' } })).toBe(
      '{"message":"failed"}',
    );
  });

  it('keeps ordered text and media without exposing binary payloads', () => {
    const result = extract({
      type: 'content',
      value: [
        { type: 'text', text: 'before' },
        {
          type: 'file-data',
          mediaType: 'audio/ogg',
          filename: 'voice.ogg',
          data: 'SECRET_BINARY',
        },
        { type: 'image-data', mediaType: 'image/png', data: 'SECRET_BINARY' },
        {
          type: 'file-url',
          mediaType: 'application/pdf',
          url: 'https://example.test/document.pdf?token=SECRET_TOKEN&signature=SECRET_SIGNATURE',
        },
        { type: 'text', text: 'after' },
      ],
    });
    expect(result).toBe(
      'before\n[Audio attachment: audio/ogg]\n[Image attachment: image/png]\n[File attachment: application/pdf]\nafter',
    );
    expect(result).not.toContain('SECRET_BINARY');
    expect(result).not.toContain('https://');
    expect(result).not.toContain('SECRET_TOKEN');
    expect(result).not.toContain('SECRET_SIGNATURE');
  });

  it.each(['media', 'file-id', 'file', 'image', 'image-url'])(
    'notes %s content',
    (type) => {
      for (const url of [
        'data:image/png;base64,SECRET',
        'https://example.test/image.png?token=SECRET&signature=SECRET_SIGNATURE',
        'https://example.test/image.png',
      ]) {
        const result = extract({
          type: 'content',
          value: [{ type, url }],
        } as ToolResultPart['output']);
        expect(result).toMatch(/\[(?:Media|File|Image) attachment:/);
        expect(result).toContain(`attachment: ${type}]`);
        expect(result).not.toContain(url);
        expect(result).not.toContain('SECRET');
      }
    },
  );

  it('handles empty content', () => {
    expect(extract({ type: 'content', value: [] })).toBe('');
  });

  it.each([
    'https://example.test/voice.ogg?token=SECRET',
    'file:///private/SECRET.ogg',
    'voice.ogg?token=SECRET',
  ])('omits untrusted filename %s', (filename) => {
    expect(
      extract({
        type: 'content',
        value: [
          {
            type: 'file-data',
            mediaType: 'audio/ogg',
            data: 'SECRET',
            filename,
          },
        ],
      }),
    ).toBe('[Audio attachment: audio/ogg]');
  });
});
