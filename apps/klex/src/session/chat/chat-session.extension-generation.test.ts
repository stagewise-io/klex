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
  const submit = vi.fn(({ value }: { value: string }) => ({ value }));
  const args: GenerateTextArgs = {
    modelIds: models.map((_, index) => ({
      providerId: 'test',
      modelId: String(index),
    })),
    prompt: 'Submit a value.',
    tools: {
      submit: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: submit,
      }),
    },
  };
  return { generate: deps.generateText, session, args, submit };
}

describe('single-step extension generation', () => {
  it('executes one step and retains text, model and usage without a learning-result contract', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call('accepted')] });
    const { generate, session, args, submit } = await harness([model]);
    try {
      expect(await generate(args)).toMatchObject({
        success: true,
        text: '',
        modelId: '0',
        usage: { totalTokens: 2 },
      });
      expect(submit).toHaveBeenCalledOnce();
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'auto' });
    } finally {
      await session.close();
    }
  });
  it.each(['content-filter', 'error', 'throw'] as const)(
    'falls back after %s',
    async (finish) => {
      const losing = new MockLanguageModelV4({
        doGenerate: async () => {
          if (finish === 'throw') throw new Error('Provider unavailable');
          return { ...call('unused', finish), content: [] };
        },
      });
      const winning = new MockLanguageModelV4({
        doGenerate: [call('winning')],
      });
      const { generate, session, args, submit } = await harness([
        losing,
        winning,
      ]);
      try {
        expect(await generate(args)).toMatchObject({
          success: true,
          modelId: '1',
        });
        expect(submit).toHaveBeenCalledOnce();
        expect(winning.doGenerateCalls).toHaveLength(1);
      } finally {
        await session.close();
      }
    },
  );
  it('classifies exhausted content-filter results', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [{ ...call('filtered', 'content-filter'), content: [] }],
    });
    const { generate, session, args } = await harness([model]);
    try {
      expect(await generate(args)).toMatchObject({
        success: false,
        failureReason: 'content-filter',
      });
    } finally {
      await session.close();
    }
  });
  it('cancels before starting a model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call('unused')] });
    const { generate, session, args } = await harness([model]);
    const controller = new AbortController();
    controller.abort();
    try {
      expect(
        await generate({ ...args, abortSignal: controller.signal }),
      ).toMatchObject({ success: false, failureReason: 'cancelled' });
      expect(model.doGenerateCalls).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});
