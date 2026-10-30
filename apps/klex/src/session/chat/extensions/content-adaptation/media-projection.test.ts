import type { ModelMessage } from 'ai';
import { expect, it } from 'vitest';

import { collectMedia, projectToolMedia } from './media-projection';

it('collects SDK and MCP tool media in order without rendering payloads', () => {
  const history: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'sdk',
          toolName: 'read',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'caption' },
              { type: 'file-data', mediaType: 'audio/mp4', data: 'AUDIO' },
              {
                type: 'image-url',
                url: 'https://example.test/image?signature=SECRET',
              },
            ],
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'mcp',
          toolName: 'read',
          output: {
            type: 'json',
            value: {
              content: [
                { type: 'audio', mimeType: 'audio/wav', data: 'MCP_AUDIO' },
                {
                  type: 'image-url',
                  url: 'https://example.test/nested?token=PRIVATE_TOKEN',
                },
                {
                  type: 'file-data',
                  mediaType: 'image/png',
                  data: 'INLINE_PAYLOAD',
                },
              ],
            },
          },
        },
      ],
    },
  ];
  const before = structuredClone(history);
  expect(collectMedia(history)).toEqual([
    { type: 'file', mediaType: 'audio/mp4', data: 'AUDIO' },
    {
      type: 'image',
      image: new URL('https://example.test/image?signature=SECRET'),
    },
    { type: 'file', mediaType: 'audio/wav', data: 'MCP_AUDIO' },
    {
      type: 'image',
      image: new URL('https://example.test/nested?token=PRIVATE_TOKEN'),
    },
    { type: 'file', mediaType: 'image/png', data: 'INLINE_PAYLOAD' },
  ]);
  expect(history).toEqual(before);
});

it('collects nested error-json media in order without mutating history', () => {
  const history: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'mcp-error',
          toolName: 'read',
          output: {
            type: 'error-json',
            value: {
              content: [
                { type: 'text', text: 'Partial result before failure' },
                { type: 'audio', mimeType: 'audio/wav', data: 'ERROR_AUDIO' },
                { type: 'image', mimeType: 'image/png', data: 'ERROR_IMAGE' },
              ],
            },
          },
        },
      ],
    },
  ];
  const before = structuredClone(history);

  expect(collectMedia(history)).toEqual([
    { type: 'file', mediaType: 'audio/wav', data: 'ERROR_AUDIO' },
    { type: 'file', mediaType: 'image/png', data: 'ERROR_IMAGE' },
  ]);
  expect(history).toEqual(before);
});

it('ignores non-media objects and malformed URLs', () => {
  expect(projectToolMedia({ type: 'text', text: 'caption' })).toBeNull();
  expect(
    projectToolMedia({
      type: 'file-url',
      mediaType: 'audio/mp4',
      url: 'invalid',
    }),
  ).toBeNull();
});
