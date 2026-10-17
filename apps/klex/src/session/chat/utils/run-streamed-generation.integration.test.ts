import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  isToolUIPart,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { recallInputSchema } from '../extensions/memory/retrieval/retrieval';
import type { ExtendedUIMessage } from '../message-types';
import { ToolDispatcher } from '../step/tool-dispatcher';
import { testLogger as logger } from '../test-helpers';
import { convertToModelMessagesExtended } from './convert-to-model-messages';
import { runStreamedGeneration } from './run-streamed-generation';
import { toolsWithoutExecute } from './tools-without-execute';

function toolCallModel(input: string, toolName = 'recall') {
  const parts: LanguageModelV4StreamPart[] = [
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName,
      input,
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

function recallTools(execute = vi.fn(async () => 'Recalling...')) {
  return { recall: { inputSchema: recallInputSchema, execute } };
}

function toolError(message: ExtendedUIMessage): string {
  const part = message.parts.find(isToolUIPart);
  expect(part?.state).toBe('output-error');
  if (part?.state !== 'output-error') {
    throw new Error('Expected a failed tool call');
  }
  return part.errorText;
}

async function generate(
  input: string,
  tools = recallTools(),
  toolName = 'recall',
) {
  const dispatcher = new ToolDispatcher({
    tools,
    logger,
    modelMessages: [],
    sessionId: 'validation-test',
  });
  const result = await runStreamedGeneration({
    model: toolCallModel(input, toolName),
    tools,
    modelMessages: [{ role: 'user', content: 'Recall yesterday.' }],
    onUpdate: (message) => dispatcher.onUpdate(message),
    abortSignal: new AbortController().signal,
    logger,
    modelContext: { providerType: 'test', providerId: 'test', modelId: 'test' },
    sessionId: 'validation-test',
    compacted: false,
    basePrompt: 'Test tool error handling.',
  });
  dispatcher.sweep(result.message);
  await dispatcher.settle();
  dispatcher.reconcile(result.message);
  return { ...result, dispatcher };
}

async function expectModelError(message: ExtendedUIMessage, error: string) {
  // Exercise the same conversion used to feed persisted UI history back to the model.
  const messages = await convertToModelMessagesExtended([message], {});
  expect(messages).toContainEqual({
    role: 'tool',
    content: [
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'call-1',
        output: { type: 'error-text', value: error },
      }),
    ],
  });
}

describe('real SDK tool error baseline', () => {
  it('hides Zod validation details with the SDK default stream formatter', async () => {
    const tools = recallTools();
    const result = streamText({
      model: toolCallModel(
        JSON.stringify({ question: 'Yesterday?', scope: '' }),
      ),
      tools: toolsWithoutExecute(tools),
      messages: [{ role: 'user', content: 'Recall yesterday.' }],
      maxRetries: 0,
    });
    const messages = readUIMessageStream<ExtendedUIMessage>({
      stream: toUIMessageStream({ stream: result.stream, tools }),
    });
    let final: ExtendedUIMessage | undefined;
    for await (const message of messages) final = message;
    expect(final).toBeDefined();
    if (!final) throw new Error('Expected a streamed message');
    expect(toolError(final)).toBe('An error occurred.');
    expect(tools.recall.execute).not.toHaveBeenCalled();
    await expectModelError(final, 'An error occurred.');
  });
});

describe('streamed tool errors reaching the model', () => {
  it.each([
    {
      name: 'empty scope',
      input: { question: 'Yesterday?', scope: '' },
      detail:
        'Scope must contain an app name and optional conversation:/user: locators',
      field: 'scope',
    },
    {
      name: 'malformed scope',
      input: { question: 'Yesterday?', scope: 'some unstructured text' },
      detail:
        'Scope must contain an app name and optional conversation:/user: locators',
      field: 'scope',
    },
    {
      name: 'wrong argument type',
      input: { question: 123, scope: 'chat' },
      detail: 'expected string',
      field: 'question',
    },
    {
      name: 'missing required argument',
      input: { scope: 'chat' },
      detail: 'expected string',
      field: 'question',
    },
  ])(
    'preserves validation details for $name without executing',
    async ({ input, detail, field }) => {
      const tools = recallTools();
      const { message, dispatcher } = await generate(
        JSON.stringify(input),
        tools,
      );
      const error = toolError(message);
      expect(error).toContain('Invalid input for tool recall');
      expect(error).toContain(field);
      expect(error).toContain(detail);
      expect(tools.recall.execute).not.toHaveBeenCalled();
      expect(dispatcher.dispatchedCount).toBe(0);
      await expectModelError(message, error);
    },
  );

  it('preserves malformed JSON errors without executing', async () => {
    const tools = recallTools();
    const { message } = await generate('{"question":', tools);
    const error = toolError(message);
    expect(error).toContain('Invalid input for tool recall');
    expect(error).toContain('JSON');
    expect(tools.recall.execute).not.toHaveBeenCalled();
    await expectModelError(message, error);
  });

  it('still dispatches valid arguments exactly once', async () => {
    const tools = recallTools();
    const { message, dispatcher } = await generate(
      JSON.stringify({ question: 'Yesterday?', scope: 'chat' }),
      tools,
    );
    expect(tools.recall.execute).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchedCount).toBe(1);
    expect(message.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output: 'Recalling...',
    });
  });

  it('still forwards runtime error details through the custom executor', async () => {
    const tools = recallTools(
      vi.fn(async () => {
        throw new Error('Memory worker is unavailable. Retry shortly.');
      }),
    );
    const { message } = await generate(
      JSON.stringify({ question: 'Yesterday?', scope: 'chat' }),
      tools,
    );
    expect(tools.recall.execute).toHaveBeenCalledOnce();
    expect(toolError(message)).toBe(
      'Memory worker is unavailable. Retry shortly.',
    );
    await expectModelError(message, toolError(message));
  });

  it('keeps unrelated SDK errors generic', async () => {
    const { message } = await generate('{}', recallTools(), 'unavailableTool');
    expect(toolError(message)).toBe('An error occurred.');
    await expectModelError(message, 'An error occurred.');
  });
});
