import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';
import type {
  ExtensionDeps,
  GenerateTextArgs,
} from './extensions/extension-api';

const logging = {
  child: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
} as unknown as RootLogger;

function scope(path: string[] = []): IntrospectionScope {
  return {
    path,
    introspect: vi.fn(),
    child: (id) => scope([...path, id]),
    removeChild: vi.fn(),
  };
}

function call(
  value: string,
  finish: 'tool-calls' | 'content-filter' | 'error' = 'tool-calls',
) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: value,
        toolName: 'submit',
        input: JSON.stringify({ value }),
      },
    ],
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

async function harness(models: MockLanguageModelV4[]) {
  let deps: ExtensionDeps | undefined;
  const modelResolver: ChatSessionDependencies['modelResolver'] = {
    getLanguageModel: ({ modelId }) => {
      const model = models[Number(modelId)];
      if (!model) throw new Error('Unknown model');
      return model;
    },
    resolveModel: () => ({
      providerId: 'test',
      providerType: 'test',
      modelId: '0',
      settings: {},
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
    resolveModelInfo: () => ({
      contextSize: 32_000,
      displayName: 'Test',
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
  };
  const session = createChatSession({
    logging,
    config: {
      get: () => ({ modelSelection: { chat: ['test:0'] } }),
    } as unknown as Config,
    modelResolver,
    dataDirectory: '/tmp/klex-extension-generation-test',
    mcp: null,
    extensionFactories: [
      {
        identifier: 'test/generation',
        create: (next) => {
          deps = next;
          return {};
        },
      },
    ],
    introspectionScope: scope(),
    sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
    basePrompt: 'Test.',
  });
  await session.start();
  if (!deps) throw new Error('Extension dependencies missing');
  const submit = vi.fn(({ value }: { value: string }) =>
    value === 'invalid'
      ? { status: 'rejected', reason: 'Correct the value.' }
      : { status: 'accepted', value },
  );
  const args: GenerateTextArgs = {
    modelIds: models.map((_, index) => ({
      providerId: 'test',
      modelId: String(index),
    })),
    prompt: 'Submit a value.',
    maxSteps: 3,
    tools: {
      submit: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: submit,
      }),
    },
    completionTool: {
      name: 'submit',
      isComplete: (output) =>
        z.object({ status: z.literal('accepted') }).safeParse(output).success,
    },
  };
  return { generate: deps.generateText, session, args, submit };
}

describe('extension generation SDK contract', () => {
  it('stops on an accepted submission and returns executed tool results', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call('accepted')] });
    const { generate, session, args, submit } = await harness([model]);
    try {
      const result = await generate(args);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Generation failed');
      expect(result.text).toBe('');
      expect(result.toolResults).toEqual([
        {
          toolName: 'submit',
          output: { status: 'accepted', value: 'accepted' },
        },
      ]);
      expect(submit).toHaveBeenCalledOnce();
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('returns rejection feedback to the model and permits correction', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call('invalid'), call('corrected')],
    });
    const { generate, session, args } = await harness([model]);
    try {
      const result = await generate(args);
      expect(result.success && result.toolResults).toEqual([
        {
          toolName: 'submit',
          output: { status: 'rejected', reason: 'Correct the value.' },
        },
        {
          toolName: 'submit',
          output: { status: 'accepted', value: 'corrected' },
        },
      ]);
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
        'Correct the value.',
      );
    } finally {
      await session.close();
    }
  });

  it('forces only the completion tool on the final step and stays bounded', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call('invalid'), call('invalid'), call('invalid')],
    });
    const { generate, session, args } = await harness([model]);
    try {
      await generate(args);
      expect(model.doGenerateCalls).toHaveLength(3);
      expect(model.doGenerateCalls[0]?.toolChoice).toEqual({
        type: 'required',
      });
      expect(model.doGenerateCalls[2]?.toolChoice).toEqual({
        type: 'tool',
        toolName: 'submit',
      });
      expect(model.doGenerateCalls[2]?.tools?.map((item) => item.name)).toEqual(
        ['submit'],
      );
    } finally {
      await session.close();
    }
  });

  it.each(['content-filter', 'error'] as const)(
    'discards staged output from a %s attempt before fallback',
    async (finish) => {
      const losing = new MockLanguageModelV4({
        doGenerate: [call('losing', finish)],
      });
      const winning = new MockLanguageModelV4({
        doGenerate: [call('winning')],
      });
      const { generate, session, args, submit } = await harness([
        losing,
        winning,
      ]);
      try {
        const result = await generate(args);
        expect(submit).toHaveBeenCalledTimes(2);
        expect(result.success && result.toolResults).toEqual([
          {
            toolName: 'submit',
            output: { status: 'accepted', value: 'winning' },
          },
        ]);
      } finally {
        await session.close();
      }
    },
  );
});
