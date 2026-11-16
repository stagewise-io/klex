import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '../message-types';
import { convertToModelMessagesExtended } from './convert-to-model-messages';
import {
  MAX_PROJECTED_SANDBOX_IMAGES,
  projectSandboxToolMedia,
} from './project-sandbox-media';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function toolMessage(toolName: string, value: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName,
        output: { type: 'json', value: value as never },
      },
    ],
  };
}

function output(message: ModelMessage | undefined) {
  if (message?.role !== 'tool') throw new Error('Expected tool message');
  const part = message.content[0];
  if (part?.type !== 'tool-result') throw new Error('Expected tool result');
  return part.output;
}

describe('projectSandboxToolMedia', () => {
  it('turns MCP image content into native image parts', () => {
    const [message] = projectSandboxToolMedia([
      toolMessage('runInSandbox', {
        content: [
          { type: 'text', text: 'Clicked.' },
          { type: 'image', mimeType: 'image/jpeg', data: PIXEL },
        ],
      }),
    ]);
    expect(output(message)).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: `${JSON.stringify({
            content: [
              { type: 'text', text: 'Clicked.' },
              { type: 'image', mimeType: 'image/jpeg', attachment: 1 },
            ],
          })}\n\nImages referenced by "attachment" follow in order.`,
        },
        { type: 'text', text: 'Attachment 1:' },
        {
          type: 'file',
          mediaType: 'image/jpeg',
          data: { type: 'data', data: PIXEL },
        },
      ],
    });
  });

  it('projects image resource blobs and nested emissions', () => {
    const [message] = projectSandboxToolMedia([
      toolMessage('runInSandbox', [
        'before',
        {
          contents: [
            {
              type: 'resource',
              resource: {
                uri: 'desktop://screen',
                mimeType: 'image/png',
                blob: PIXEL,
              },
            },
          ],
        },
      ]),
    ]);
    const result = output(message);
    expect(result.type).toBe('content');
    if (result.type !== 'content') return;
    expect(result.value[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '{"uri":"desktop://screen","mimeType":"image/png","attachment":1}',
      ),
    });
    expect(result.value.at(-1)).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
    });
  });

  it('leaves other tools, non-image media and invalid base64 untouched', () => {
    const messages = [
      toolMessage('otherTool', {
        content: [{ type: 'image', mimeType: 'image/png', data: PIXEL }],
      }),
      toolMessage('runInSandbox', {
        content: [
          { type: 'image', mimeType: 'text/html', data: PIXEL },
          { type: 'image', mimeType: 'image/png', data: 'not base64!' },
          { type: 'audio', mimeType: 'audio/wav', data: PIXEL },
        ],
      }),
    ];
    expect(projectSandboxToolMedia(messages)).toEqual(messages);
  });

  it('bounds the number of projected images', () => {
    const images = Array.from(
      { length: MAX_PROJECTED_SANDBOX_IMAGES + 2 },
      () => ({ type: 'image', mimeType: 'image/png', data: PIXEL }),
    );
    const result = output(
      projectSandboxToolMedia([toolMessage('runInSandbox', images)])[0],
    );
    if (result.type !== 'content') throw new Error('Expected content');
    expect(result.value.filter((item) => item.type === 'file')).toHaveLength(
      MAX_PROJECTED_SANDBOX_IMAGES,
    );
    expect(result.value[0]).toMatchObject({
      text: expect.stringContaining(PIXEL),
    });
  });

  it('applies during model message conversion', async () => {
    const history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Look.' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-runInSandbox',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { code: 'return await mcp.machine.desktop_screenshot({})' },
            output: {
              content: [{ type: 'image', mimeType: 'image/jpeg', data: PIXEL }],
            },
          },
        ],
      },
    ] as unknown as ExtendedUIMessage[];
    const messages = await convertToModelMessagesExtended(history, {});
    const tool = messages.find((message) => message.role === 'tool');
    expect(output(tool)).toMatchObject({
      type: 'content',
      value: expect.arrayContaining([
        expect.objectContaining({ type: 'file', mediaType: 'image/jpeg' }),
      ]),
    });
  });
});
