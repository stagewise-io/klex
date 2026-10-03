import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  LanguageModelV4CallOptions,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import { completeV2Config } from '@/config/config.test-fixtures';
import { createIntrospector } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';
import {
  createDataPart,
  type ExtensionFactory,
  type InstinctContext,
  isDataPartOf,
  type StepCompleteEvent,
} from './extensions/extension-api';

const logging = createLogger({
  name: 'session-instinct-test',
  type: 'hidden',
});
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function harness(
  options: {
    disabled?: boolean;
    unavailable?: boolean;
    rejectReaction?: boolean;
    interrupt?: boolean;
    evaluationFallback?: boolean;
  } = {},
) {
  const order: string[] = [];
  const contexts: InstinctContext[] = [];
  const completed: StepCompleteEvent[] = [];
  const mainPrompts: LanguageModelV4CallOptions[] = [];
  const classifier = new MockLanguageModelV4({
    doGenerate: async (args) => {
      order.push('classifier');
      expect(args.temperature).toBe(0);
      expect(args.responseFormat?.type).toBe('json');
      return {
        content: [
          {
            type: 'text',
            text: options.evaluationFallback
              ? 'invalid JSON'
              : '{"memory":{"needed":true}}',
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  const evaluator: EvaluationModel = {
    specificationVersion: 'v4',
    provider: 'typesafe.evaluation',
    modelId: 'native',
    supportedQuestionTypes: ['boolean'],
    doEvaluate: async (args) => {
      order.push('evaluation');
      expect(args.state).toContain('Remember the project');
      return {
        answers: Object.fromEntries(
          Object.keys(args.questions).map((id) => [
            id,
            { type: 'boolean', probability: 0.9 },
          ]),
        ),
        usage: { inputTokens: 7, outputTokens: 3 },
        warnings: [],
      };
    },
  };
  const chat = new MockLanguageModelV4({
    doStream: async (args) => {
      order.push('generation');
      mainPrompts.push(args);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'text',
              delta: 'Answer.',
            });
            controller.enqueue({ type: 'text-end', id: 'text' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });
  const resolver: ChatSessionDependencies['modelResolver'] = {
    resolveInstinctCandidates: (entries) =>
      entries.map((entry) =>
        entry.api === 'evaluation'
          ? {
              status: 'ready',
              entry,
              providerType: 'typesafe-ai',
              api: 'evaluation',
              model: evaluator,
            }
          : {
              status: 'ready',
              entry,
              providerType: 'openai',
              api: 'generation',
              model: entry.modelId === 'classifier' ? classifier : chat,
            },
      ),
    getLanguageModel: (entry) =>
      entry.modelId === 'classifier' ? classifier : chat,
    resolveModel: (entry) => ({
      ...entry,
      providerType: 'test',
      settings: {},
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
    resolveModelInfo: () => ({
      displayName: 'Test Model',
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
  };
  const configValue = {
    ...completeV2Config,
    instinct: { ...completeV2Config.instinct, enabled: !options.disabled },
    modelSelection: {
      ...completeV2Config.modelSelection,
      chat: [{ providerId: 'test', modelId: 'chat' }],
      instincts: options.unavailable
        ? []
        : [
            { providerId: 'test', modelId: 'classifier', api: 'generation' },
            ...(options.evaluationFallback
              ? [{ providerId: 'test', modelId: 'native', api: 'evaluation' }]
              : []),
          ],
    },
  };
  const config = {
    get: () => configValue,
    getModelSelection: ((purpose) =>
      configValue.modelSelection[purpose]) as Config['getModelSelection'],
    subscribe: () => () => {},
  } as unknown as Config;
  const extension: ExtensionFactory = {
    identifier: 'memory',
    create: (deps) => ({
      dataPartTransformers: {
        'instinct-test': () => [{ type: 'text', text: 'persistent memory' }],
      },
      getInstinctClassificationRequest: () => ({
        prompt: 'Memory needed?',
        keys: { needed: { type: 'boolean', description: 'Memory helps.' } },
      }),
      onInstinct: async (ctx) => {
        order.push('reaction');
        contexts.push(ctx);
        ctx.prepare.appendPersistent([
          createDataPart('instinct-test', {}) as never,
        ]);
        ctx.prepare.appendProvisional([
          { type: 'text', text: 'provisional memory' },
        ]);
        ctx.prepare.appendEphemeral([
          { type: 'text', text: 'ephemeral memory' },
        ]);
        await Promise.resolve();
        if (options.rejectReaction) throw new Error('retrieval failed');
        if (options.interrupt && contexts.length === 1)
          deps.inbox.sendMessage(
            {
              id: 'interrupt',
              role: 'user',
              parts: [{ type: 'text', text: 'Critical replacement input' }],
            },
            SessionInboxUrgency.Critical,
          );
      },
      onStepStart: () => {
        order.push('step-start');
      },
      onStepComplete: (event) => {
        completed.push(event);
      },
    }),
  };
  const session = createChatSession({
    logging,
    config,
    modelResolver: resolver,
    dataDirectory: '/tmp/instinct-session-test',
    mcp: null,
    introspectionScope: createIntrospector({ logging }).child('sessions'),
    extensionFactories: [extension],
    basePrompt: 'You are Klex.',
    sessionContext: {
      kind: 'default',
      name: 'main',
      sessionId: 'instinct-test',
    },
  });
  const send = async (text: string) => {
    session.inbox.sendMessage(
      {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      },
      SessionInboxUrgency.Default,
    );
    expect(await session.waitForIdle(2_000)).toBe(true);
  };
  return { session, send, order, contexts, completed, mainPrompts };
}

describe('ChatSession instinct integration', () => {
  it('classifies and awaits reactions, retaining persistent and successful provisional preparation', async () => {
    const { session, send, order, contexts, completed, mainPrompts } =
      harness();
    try {
      await session.start();
      await send('Remember the project');
      // Existing step-start notification precedes the executable-step check.
      expect(order.filter((entry) => entry !== 'step-start')).toEqual([
        'classifier',
        'reaction',
        'generation',
      ]);
      expect(contexts[0]?.classification).toMatchObject({
        status: 'ok',
        answers: { needed: true },
      });
      const prompt = JSON.stringify(mainPrompts[0]?.prompt);
      expect(prompt).toContain('persistent memory');
      expect(prompt).toContain('provisional memory');
      expect(prompt).toContain('ephemeral memory');
      const history = JSON.stringify(session.getMessages());
      expect(history).toContain('data-instinct-test');
      expect(history).toContain('provisional memory');
      expect(history).not.toContain('ephemeral memory');
      expect(completed[0]?.instinct?.classifierStatus).toBe('ok');
      expect(
        session.getSessionInfo().usage.extensions['core:instinct-classifier']
          ?.total.inputTokens,
      ).toBe(10);
      await send('Next input');
      expect(contexts[1]?.delta.initial).toBe(false);
      expect(
        contexts[1]?.delta.added.some((message) =>
          message.parts.some((part) => isDataPartOf('instinct-test', part)),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('accounts failed generation and evaluation fallback, then commits preparation before the main step', async () => {
    const { session, send, order, contexts, mainPrompts } = harness({
      evaluationFallback: true,
    });
    try {
      await session.start();
      await send('Remember the project');
      expect(order.filter((entry) => entry !== 'step-start')).toEqual([
        'classifier',
        'evaluation',
        'reaction',
        'generation',
      ]);
      expect(contexts[0]?.classification).toMatchObject({
        status: 'ok',
        modelId: 'native',
        answers: { needed: true },
        evaluation: { needed: { probability: 0.9 } },
      });
      expect(JSON.stringify(mainPrompts[0]?.prompt)).toContain(
        'provisional memory',
      );
      expect(
        session.getSessionInfo().usage.extensions['core:instinct-classifier']
          ?.total,
      ).toMatchObject({ inputTokens: 17, outputTokens: 8 });
    } finally {
      await session.close();
    }
  });

  it('rolls back an interrupted instinct, then classifies the new input before generating', async () => {
    const { session, send, contexts, completed, mainPrompts } = harness({
      interrupt: true,
    });
    try {
      await session.start();
      await send('Initial input');
      // Existing Critical-input semantics include a final check-retry turn.
      expect(contexts).toHaveLength(3);
      expect(contexts[0]?.signal.aborted).toBe(true);
      expect(contexts[1]?.delta.initial).toBe(true);
      expect(
        contexts[1]?.delta.added.some((message) => message.id === 'interrupt'),
      ).toBe(true);
      expect(completed[0]?.instinctAborted).toBe(true);
      expect(mainPrompts).toHaveLength(2);
      expect(
        session
          .getMessages()
          .filter((message) =>
            message.parts.some((part) => isDataPartOf('instinct-test', part)),
          ),
      ).toHaveLength(mainPrompts.length);
    } finally {
      await session.close();
    }
  });

  it.each([
    { disabled: true },
    { unavailable: true },
    { rejectReaction: true },
  ])('continues main generation for %j', async (options) => {
    const { session, send, order, contexts, mainPrompts } = harness(options);
    try {
      await session.start();
      await send('New input');
      expect(order).toContain('generation');
      if (options.disabled) expect(contexts).toHaveLength(0);
      if (options.unavailable)
        expect(contexts[0]?.classification?.status).toBe('unavailable');
      if (options.rejectReaction) {
        expect(JSON.stringify(mainPrompts[0]?.prompt)).not.toContain('memory');
        expect(JSON.stringify(session.getMessages())).not.toContain(
          'data-instinct-test',
        );
      }
    } finally {
      await session.close();
    }
  });
});
