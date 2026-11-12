import { APICallError, NoOutputGeneratedError, type ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '../message-types';
import {
  extractMissingOpenAIItemId,
  stripOpenAIItemReferences,
  stripOpenAIItemReferencesFromMessages,
  stripOpenAIItemReferencesFromModelMessages,
} from './repair-missing-item-references';

const missing = "Item with id 'rs_missing' not found.";
const ui = (parts: unknown[]): ExtendedUIMessage =>
  ({ id: 'history', role: 'assistant', parts }) as ExtendedUIMessage;

describe('extractMissingOpenAIItemId', () => {
  const apiError = new APICallError({
    message: missing,
    statusCode: 404,
    url: 'https://example.com',
    requestBodyValues: {},
  });
  it.each([
    apiError,
    new NoOutputGeneratedError({ cause: apiError }),
    {
      message: 'failed',
      statusCode: 400,
      responseBody: JSON.stringify({ message: missing }),
    },
    { lastError: { cause: apiError } },
    'Item with id "rs_missing" not found.',
    { statusCode: 500, message: missing, cause: apiError },
  ])('extracts from errors and nested wrappers (%#)', (error) => {
    expect(extractMissingOpenAIItemId(error)).toBe('rs_missing');
  });
  it.each([
    { statusCode: 404, message: 'Requested entity was not found.' },
    { statusCode: 500, message: missing },
    null,
    { responseBody: { message: missing } },
  ])('ignores unrelated errors (%#)', (error) => {
    expect(extractMissingOpenAIItemId(error)).toBeNull();
  });
  it('bounds traversal and avoids cycles while checking both branches', () => {
    const cycle: Record<string, unknown> = {};
    cycle.lastError = cycle;
    cycle.cause = apiError;
    expect(extractMissingOpenAIItemId(cycle)).toBe('rs_missing');
    let deep: unknown = apiError;
    for (let i = 0; i < 11; i++) deep = { cause: deep };
    expect(extractMissingOpenAIItemId(deep)).toBeNull();
  });
});

describe('stripOpenAIItemReferences', () => {
  it.each(['openai', 'azure'])(
    'repairs UI history for %s and preserves inline content',
    (provider) => {
      const messages = [
        ui([
          {
            type: 'reasoning',
            text: 'lost',
            providerMetadata: { [provider]: { itemId: 'rs_lost' } },
          },
          {
            type: 'reasoning',
            text: 'encrypted',
            providerMetadata: {
              [provider]: {
                itemId: 'rs_kept',
                reasoningEncryptedContent: 'cipher',
              },
            },
          },
          {
            type: 'reasoning',
            text: 'other',
            providerMetadata: { other: { signature: 'sig' } },
          },
          {
            type: 'text',
            text: 'hello',
            providerMetadata: { [provider]: { itemId: 'msg_lost' } },
          },
          {
            type: 'dynamic-tool',
            toolName: 'test',
            toolCallId: 'call',
            state: 'output-available',
            input: {},
            output: 'ok',
            callProviderMetadata: {
              [provider]: {
                itemId: 'fc_lost',
                parallelToolCall: { itemId: 'parallel' },
              },
            },
            resultProviderMetadata: { [provider]: { itemId: 'result_lost' } },
          },
          {
            type: 'custom',
            kind: 'openai.compaction',
            providerMetadata: { [provider]: { itemId: 'cmp_lost' } },
          },
        ]),
      ];
      expect(stripOpenAIItemReferencesFromMessages(messages)).toBe(true);
      expect(messages[0]!.parts).toEqual([
        {
          type: 'reasoning',
          text: 'encrypted',
          providerMetadata: {
            [provider]: { reasoningEncryptedContent: 'cipher' },
          },
        },
        {
          type: 'reasoning',
          text: 'other',
          providerMetadata: { other: { signature: 'sig' } },
        },
        { type: 'text', text: 'hello' },
        {
          type: 'dynamic-tool',
          toolName: 'test',
          toolCallId: 'call',
          state: 'output-available',
          input: {},
          output: 'ok',
          callProviderMetadata: {
            [provider]: { parallelToolCall: { itemId: 'parallel' } },
          },
        },
      ]);
      expect(stripOpenAIItemReferencesFromMessages(messages)).toBe(false);
    },
  );

  it.each(['providerOptions', 'providerMetadata'])(
    'repairs model content in %s',
    (field) => {
      const messages = [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'lost',
              [field]: { openai: { itemId: 'rs_lost' } },
            },
            {
              type: 'reasoning',
              text: 'kept',
              [field]: {
                azure: {
                  itemId: 'rs_kept',
                  reasoningEncryptedContent: 'cipher',
                },
              },
            },
            {
              type: 'text',
              text: 'hello',
              [field]: { openai: { itemId: 'msg_lost' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call',
              toolName: 'test',
              input: {},
              [field]: {
                openai: {
                  itemId: 'fc_lost',
                  parallelToolCall: { itemId: 'parallel' },
                },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call',
              toolName: 'test',
              output: { type: 'text', value: 'ok' },
              [field]: { azure: { itemId: 'result' } },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'custom',
              kind: 'openai.compaction',
              [field]: { openai: { itemId: 'cmp' } },
            },
          ],
        },
      ] as ModelMessage[];
      expect(stripOpenAIItemReferencesFromModelMessages(messages)).toBe(true);
      expect(messages).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'kept',
              [field]: { azure: { reasoningEncryptedContent: 'cipher' } },
            },
            { type: 'text', text: 'hello' },
            {
              type: 'tool-call',
              toolCallId: 'call',
              toolName: 'test',
              input: {},
              [field]: { openai: { parallelToolCall: { itemId: 'parallel' } } },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call',
              toolName: 'test',
              output: { type: 'text', value: 'ok' },
            },
          ],
        },
      ]);
      expect(stripOpenAIItemReferencesFromModelMessages(messages)).toBe(false);
    },
  );

  it('repairs both arrays and removes only newly emptied messages', () => {
    const messages = [
      ui([
        { type: 'step-start' },
        {
          type: 'reasoning',
          text: '',
          providerMetadata: { openai: { itemId: 'rs' } },
        },
      ]),
      ui([]),
    ];
    const modelMessages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '',
            providerOptions: { openai: { itemId: 'rs' } },
          },
        ],
      },
      { role: 'assistant', content: [] },
    ];
    expect(stripOpenAIItemReferences(messages, modelMessages)).toBe(true);
    expect(messages).toEqual([ui([])]);
    expect(modelMessages).toEqual([{ role: 'assistant', content: [] }]);
    expect(stripOpenAIItemReferences(messages, modelMessages)).toBe(false);
  });

  it('keeps other provider metadata and reasoning without references', () => {
    const messages = [
      ui([
        {
          type: 'reasoning',
          text: 'other',
          providerMetadata: {
            openai: { itemId: 'rs', reasoningEncryptedContent: '' },
            other: { signature: 'sig' },
          },
        },
        { type: 'reasoning', text: 'plain' },
      ]),
    ];
    stripOpenAIItemReferencesFromMessages(messages);
    expect(messages[0]!.parts).toEqual([
      {
        type: 'reasoning',
        text: 'other',
        providerMetadata: { other: { signature: 'sig' } },
      },
      { type: 'reasoning', text: 'plain' },
    ]);
  });
});
