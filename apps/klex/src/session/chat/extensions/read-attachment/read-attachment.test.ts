import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage, Tool } from 'ai';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import {
  REMOTE_INPUT_UNAVAILABLE,
  remoteInputUnavailable,
} from '@/provider-registry/remote-input';
import { convertToModelMessagesExtended } from '@/session/chat/utils/convert-to-model-messages';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import { createReadAttachmentExt } from './read-attachment';

const url = 'https://media.example/file?secret=private';
const selected: ResolvedModel = {
  modelId: 'gpt-4o',
  reference: { providerId: 'remote', modelId: 'gpt-4o' },
  contextSize: 128000,
  inputCapabilities: { image: {} },
};

function fixture() {
  const generateText = vi.fn();
  const modelResolver = {
    getLanguageModel: vi.fn(() =>
      createOpenAI({ apiKey: 'key' }).responses('gpt-4o'),
    ),
  };
  const extension = createReadAttachmentExt.create({
    modelResolver,
    generateText,
  } as unknown as ExtensionDeps);
  const tool = extension.getTools?.(selected).readAttachment as Tool<{
    url: string;
    mediaType?: string;
  }>;
  const run = tool.execute;
  const transform = extension.contextTransformer;
  assert(run);
  assert(transform);
  const execute = (input: { url: string; mediaType?: string }) =>
    run(input, { toolCallId: 'call', messages: [], context: undefined });
  return { transform, execute, modelResolver, generateText };
}

afterEach(() => vi.unstubAllGlobals());

describe('readAttachment', () => {
  it('carries a JSON-roundtripped tool result into next-turn structured file input with no I/O or separate generation', async () => {
    const fetch = vi.fn(() => {
      throw new Error('No local downloads');
    });
    vi.stubGlobal('fetch', fetch);
    const { transform, execute, generateText, modelResolver } = fixture();
    const output = await execute({ url, mediaType: 'application/pdf' });
    const messages = await convertToModelMessagesExtended(
      JSON.parse(
        JSON.stringify([
          {
            id: 'message',
            role: 'assistant',
            parts: [
              {
                type: 'dynamic-tool',
                toolName: 'readAttachment',
                toolCallId: 'call',
                state: 'output-available',
                input: { url, mediaType: 'application/pdf' },
                output,
              },
            ],
          },
        ]),
      ),
      {},
    );
    const converted = (await transform(messages, selected)) as ModelMessage[];
    expect(converted[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: 'readAttachment',
          toolCallId: 'call',
          output: {
            type: 'content',
            value: [
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'url', url: new URL(url) },
              },
            ],
          },
        },
      ],
    });
    expect(modelResolver.getLanguageModel).toHaveBeenLastCalledWith(
      selected.reference,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('gates replay against the new model without altering canonical history', async () => {
    const { transform, execute } = fixture();
    const output = await execute({ url, mediaType: 'image/png' });
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call',
            toolName: 'readAttachment',
            output: { type: 'json', value: output },
          },
        ],
      },
    ] as ModelMessage[];
    const original = JSON.stringify(messages);
    const converted = (await transform(messages, {
      ...selected,
      inputCapabilities: {},
    })) as ModelMessage[];
    expect(JSON.stringify(converted)).not.toContain(url);
    expect(JSON.stringify(converted)).toContain(REMOTE_INPUT_UNAVAILABLE);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it('sanitizes resolver exceptions and missing media types', async () => {
    const { execute, modelResolver } = fixture();
    expect(await execute({ url })).toEqual(remoteInputUnavailable());
    modelResolver.getLanguageModel.mockImplementation(() => {
      throw new Error(`provider secret ${url}`);
    });
    expect(await execute({ url, mediaType: 'application/pdf' })).toEqual(
      remoteInputUnavailable(),
    );
  });

  it('does not convert unrelated tool output or malformed attachment results', async () => {
    const { transform } = fixture();
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 'other',
            output: { type: 'json', value: { url } },
          },
          {
            type: 'tool-result',
            toolCallId: 'b',
            toolName: 'readAttachment',
            output: { type: 'json', value: { url, error: 'provider details' } },
          },
        ],
      },
    ];
    const result = (await transform(messages, selected)) as ModelMessage[];
    expect(result[0]).toEqual({
      role: 'tool',
      content: [
        messages[0]?.content[0],
        {
          type: 'tool-result',
          toolCallId: 'b',
          toolName: 'readAttachment',
          output: remoteInputUnavailable(),
        },
      ],
    });
  });
});
