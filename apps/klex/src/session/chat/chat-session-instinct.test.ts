import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  LanguageModelV4CallOptions,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import { completeV2Config } from '@/config/config.test-fixtures';
import { createIntrospector } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';
import { createTelemetrySpanProcessor } from '@/telemetry-manager';
import { createTelemetryPolicy } from '@/telemetry-policy';
import { createTracing, type Tracing } from '@/tracing';

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
    interrupt?: boolean;
    evaluationFallback?: boolean;
    evaluationOnly?: boolean;
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
              : JSON.stringify({ q0: 1 }),
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
    doGenerate: (args) => classifier.doGenerate(args),
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
    resolveInstinctCandidates: vi.fn<
      ChatSessionDependencies['modelResolver']['resolveInstinctCandidates']
    >((entries) =>
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
    modelSelection: {
      ...completeV2Config.modelSelection,
      chat: [{ providerId: 'test', modelId: 'chat' }],
      instincts: [
        {
          providerId: 'test',
          modelId: options.evaluationOnly ? 'native' : 'classifier',
          api: options.evaluationOnly ? 'evaluation' : 'generation',
        },
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
        keys: {
          needed: { type: 'boolean', description: 'Memory helps.' },
        },
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
  return {
    session,
    send,
    order,
    contexts,
    completed,
    mainPrompts,
    configValue,
    resolver,
  };
}

function requiredSpan(
  span: ReadableSpan | undefined,
  name: string,
): ReadableSpan {
  if (span === undefined) throw new Error(`Missing trace span: ${name}`);
  return span;
}

describe('ChatSession instinct tracing', () => {
  const exporter = new InMemorySpanExporter();
  const processor = createTelemetrySpanProcessor('advanced');
  const policy = createTelemetryPolicy('advanced');
  let tracing: Tracing;
  let finishedBeforeMain: ReadableSpan[] = [];

  beforeAll(async () => {
    vi.stubGlobal('AI_SDK_TELEMETRY_INTEGRATIONS', []);
    // Exercise the production context manager, SDK registration, content gate,
    // and export-time privacy filtering rather than invoking telemetry hooks.
    tracing = createTracing({
      logging,
      serviceName: 'session-instinct-test',
      spanProcessor: processor,
      policy,
    });
    const delegate = new SimpleSpanProcessor(exporter);
    vi.spyOn(delegate, 'onStart').mockImplementation((span) => {
      if (span.attributes['klex.call.source'] === 'chat')
        finishedBeforeMain = exporter.getFinishedSpans();
    });
    processor.setDelegate(delegate);
    await tracing.start();
  });
  afterAll(async () => {
    await tracing.close();
    await exporter.shutdown();
    context.disable();
    trace.disable();
    vi.unstubAllGlobals();
  });

  it.each(
    (['advanced', 'debug'] as const).flatMap((level) =>
      [
        {
          backend: 'generation',
          evaluationOnly: false,
          evaluationFallback: false,
        },
        {
          backend: 'evaluation',
          evaluationOnly: true,
          evaluationFallback: false,
        },
        {
          backend: 'mixed fallback',
          evaluationOnly: false,
          evaluationFallback: true,
        },
      ].map((options) => ({ level, ...options })),
    ),
  )(
    'exports $backend instinct before main generation at $level',
    async (options) => {
      exporter.reset();
      finishedBeforeMain = [];
      processor.setLevel(options.level);
      policy.setLevel(options.level);
      const { session, send } = harness(options);
      try {
        await session.start();
        await send('Remember the project');
      } finally {
        await session.close();
      }
      await tracing.forceFlush();

      const spans = exporter.getFinishedSpans();
      const named = (name: string) =>
        requiredSpan(
          spans.find((span) => span.name === name),
          name,
        );
      const root = named('session main');
      const turn = named('turn');
      const step = named('step');
      const phase = named('step.instinct');
      const classifier = named('step.instinct.classifier');
      const attempts = spans.filter((span) => span.name === 'instinct.attempt');
      const calls = spans.filter(
        (span) =>
          span.attributes['klex.call.source'] === 'extension' &&
          attempts.some(
            (attempt) =>
              attempt.spanContext().spanId === span.parentSpanContext?.spanId,
          ),
      );
      const main = requiredSpan(
        spans.find(
          (span) =>
            span.attributes['klex.call.source'] === 'chat' &&
            span.parentSpanContext?.spanId === step.spanContext().spanId,
        ),
        'main generation',
      );
      expect(turn?.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(step?.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
      expect(phase?.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
      expect(classifier?.parentSpanContext?.spanId).toBe(
        phase.spanContext().spanId,
      );
      expect(main?.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
      expect(attempts).toHaveLength(options.evaluationFallback ? 2 : 1);
      expect(calls).toHaveLength(attempts.length);
      expect(main.attributes).toMatchObject({
        'gen_ai.conversation.id': session.sessionId,
        'klex.model.api': 'generation',
        'gen_ai.request.stream': true,
      });
      for (const span of [
        turn,
        step,
        phase,
        classifier,
        ...attempts,
        ...calls,
        main,
      ]) {
        expect(span.spanContext().traceId).toBe(root.spanContext().traceId);
      }
      for (const attempt of attempts) {
        expect(attempt.parentSpanContext?.spanId).toBe(
          classifier.spanContext().spanId,
        );
        const call = requiredSpan(
          calls.find(
            (span) =>
              span.parentSpanContext?.spanId === attempt.spanContext().spanId,
          ),
          'instinct model call',
        );
        expect(call.attributes['gen_ai.conversation.id']).toBe(
          session.sessionId,
        );
      }
      // Observe actual lifecycle order at the main span's onStart. Comparing
      // nanosecond timestamps is unreliable: SDK spans use per-span wall-clock
      // baselines with millisecond precision and high-resolution durations.
      expect(
        finishedBeforeMain.map((span) => span.spanContext().spanId),
      ).toEqual(
        expect.arrayContaining(
          [phase, classifier, ...attempts, ...calls].map(
            (span) => span.spanContext().spanId,
          ),
        ),
      );
      expect(calls.map((span) => span.attributes['klex.model.api'])).toEqual(
        options.evaluationFallback
          ? ['generation', 'evaluation']
          : [options.evaluationOnly ? 'evaluation' : 'generation'],
      );

      const successful = requiredSpan(
        calls.find(
          (span) =>
            span.attributes['klex.model.api'] ===
            (options.evaluationOnly || options.evaluationFallback
              ? 'evaluation'
              : 'generation'),
        ),
        'successful instinct call',
      );
      if (successful.name === 'evaluate') {
        expect(successful.attributes['klex.outcome']).toBe('success');
      } else {
        expect(
          successful.attributes['gen_ai.response.finish_reasons'],
        ).toContain('stop');
      }
      if (options.level === 'debug') {
        if (successful.name === 'evaluate') {
          expect(
            successful.attributes['klex.evaluation.input.content'],
          ).toContain('Remember the project');
          expect(
            successful.attributes['klex.evaluation.questions.content'],
          ).toContain('Memory helps.');
          expect(
            successful.attributes['klex.evaluation.answers.content'],
          ).toContain('0.9');
        } else {
          const instructions = JSON.parse(
            String(successful.attributes['gen_ai.system_instructions']),
          ) as { content: string }[];
          expect(
            instructions.map(({ content }) => content).join('\n'),
          ).toContain('<question id="q0"');
          expect(successful.attributes['gen_ai.input.messages']).toContain(
            'Remember the project',
          );
          expect(successful.attributes['gen_ai.output.messages']).toContain(
            'q0',
          );
        }
        expect(main.attributes['gen_ai.input.messages']).toContain(
          'persistent memory',
        );
        expect(main.attributes['gen_ai.output.messages']).toContain('Answer.');
      } else {
        for (const call of [...calls, main]) {
          for (const key of [
            'gen_ai.system_instructions',
            'gen_ai.input.messages',
            'gen_ai.output.messages',
            'klex.evaluation.input.content',
            'klex.evaluation.questions.content',
            'klex.evaluation.answers.content',
          ]) {
            expect(call.attributes).not.toHaveProperty(key);
          }
        }
      }
    },
  );
});

describe('ChatSession instinct integration', () => {
  it('classifies and awaits reactions, retaining persistent and successful provisional preparation', async () => {
    const {
      session,
      send,
      order,
      contexts,
      completed,
      mainPrompts,
      configValue,
      resolver,
    } = harness();
    try {
      await session.start();
      await send('Remember the project');
      expect(resolver.resolveInstinctCandidates).toHaveBeenCalledWith(
        configValue.modelSelection.instincts,
      );
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

  it('uses ordered Chat models through generation when Instincts is empty without changing config', async () => {
    const { session, send, order, contexts, configValue, resolver } = harness();
    configValue.modelSelection.instincts = [];
    const chatEntries = [
      {
        providerId: 'test',
        modelId: 'chat',
        providerOptions: { openai: { reasoningEffort: 'low' } },
      },
      { providerId: 'test', modelId: 'backup-chat' },
    ];
    configValue.modelSelection.chat = chatEntries;
    const before = structuredClone(configValue.modelSelection);
    try {
      await session.start();
      await send('Remember the project');
      expect(resolver.resolveInstinctCandidates).toHaveBeenCalledWith(
        chatEntries.map((entry) => ({ ...entry, api: 'generation' })),
      );
      expect(contexts[0]?.classification).toMatchObject({
        status: 'ok',
        modelId: 'chat',
        answers: { needed: true },
      });
      expect(order.filter((entry) => entry !== 'step-start')).toEqual([
        'classifier',
        'reaction',
        'generation',
      ]);
      expect(configValue.modelSelection).toEqual(before);
      expect(
        session.getSessionInfo().usage.extensions['core:instinct-classifier']
          ?.total.inputTokens,
      ).toBe(10);
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
});
