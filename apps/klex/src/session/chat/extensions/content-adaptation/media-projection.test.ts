import type { ModelMessage } from 'ai';
import { expect, it } from 'vitest';

import type { ExtendedUIMessage } from '../../message-types';
import { convertToModelMessagesExtended } from '../../utils/convert-to-model-messages';
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

it.each([
  ['image-data', 'image/png'],
  ['file-data', 'audio/wav'],
  ['file-data', 'application/pdf'],
] as const)(
  'collects SDK %s (%s) through the real UI converter and nested JSON wrappers',
  async (type, mediaType) => {
    const payload = { type, mediaType, data: 'ORIGINAL_BYTES' };
    const sdk = { type: 'content', value: [payload] };
    for (const output of [
      sdk,
      { type: 'json', value: sdk },
      { type: 'error-json', value: { type: 'json', value: sdk } },
    ]) {
      const ui: ExtendedUIMessage[] = [
        {
          id: 'sdk-message',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'read',
              toolCallId: 'sdk-call',
              state: 'output-available',
              input: {},
              output,
            },
          ],
        },
      ];
      const before = structuredClone(ui);
      const converted = await convertToModelMessagesExtended(ui, {});
      expect(converted.some((message) => message.role === 'tool')).toBe(true);
      expect(collectMedia(converted)).toEqual([
        { type: 'file', mediaType, data: payload.data },
      ]);
      expect(ui).toEqual(before);
    }
  },
);

it('does not traverse arbitrary fields, metadata, or cyclic JSON envelopes', () => {
  const sdk = {
    type: 'content',
    value: [{ type: 'image-data', mediaType: 'image/png', data: 'HIDDEN' }],
  };
  const cycle: { type: 'json'; value?: unknown } = { type: 'json' };
  cycle.value = cycle;
  for (const value of [null, { metadata: sdk }, { nested: sdk }, cycle]) {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'unrecognized',
            toolName: 'read',
            output: { type: 'json', value },
          },
        ],
      },
    ] as ModelMessage[];
    expect(collectMedia(messages)).toEqual([]);
  }
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
