import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { experimental_evaluate as evaluate, generateText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import z from 'zod';

import type { ModelCallRecord } from '@/model-call-logger';
import type { InstinctModelCandidate } from '@/provider-registry';
import { executeInstinctClassification } from '@/session/chat/instinct';
import { createTelemetrySpanProcessor } from '@/telemetry-manager';

import {
  GenAiIdentitySpanProcessor,
  KlexOpenTelemetry,
  type KlexOpenTelemetryOptions,
  ModelCallUsageTelemetry,
} from './telemetry';

function createTelemetry(): ModelCallUsageTelemetry {
  return new ModelCallUsageTelemetry();
}

// Cast helpers — the AI SDK event types are large unions with many
// required fields we don't use. The integrations only read a small subset,
// so we cast through `unknown` to avoid constructing full mock objects.
type StartEvent = Parameters<ModelCallUsageTelemetry['onStart']>[0];
type EndEvent = Parameters<ModelCallUsageTelemetry['onEnd']>[0];
type AbortEvent = Parameters<ModelCallUsageTelemetry['onAbort']>[0];
type CallEndEvent = Parameters<
  ModelCallUsageTelemetry['onLanguageModelCallEnd']
>[0];

function makeStartEvent(event: Record<string, unknown>): StartEvent {
  return event as unknown as StartEvent;
}

function makeEndEvent(event: Record<string, unknown>): EndEvent {
  return event as unknown as EndEvent;
}

function createSpanHarness(
  level: 'advanced' | 'debug',
  options: KlexOpenTelemetryOptions = {},
) {
  const exporter = new InMemorySpanExporter();
  const spanProcessor = createTelemetrySpanProcessor(level);
  spanProcessor.setDelegate(new SimpleSpanProcessor(exporter));
  const provider = new BasicTracerProvider({
    spanProcessors: [spanProcessor],
  });
  const telemetry = new KlexOpenTelemetry(provider.getTracer('test'), {
    contentAllowed: () => level === 'debug',
    ...options,
  });
  return { exporter, provider, telemetry };
}

function makeAbortEvent(event: Record<string, unknown>): AbortEvent {
  return event as unknown as AbortEvent;
}

function makeCallEndEvent(event: Record<string, unknown>): CallEndEvent {
  return event as unknown as CallEndEvent;
}

function createMockLanguageModel(modelId = 'gpt-test') {
  return new MockLanguageModelV4({
    provider: 'openai.chat',
    modelId,
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Model output' }],
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
    }),
  });
}

async function exportContentCall(options: {
  level: 'advanced' | 'debug';
  telemetryOptions?: KlexOpenTelemetryOptions;
  functionId?: string;
  runtimeContext?: Record<string, unknown>;
  recordInputs?: boolean;
  recordOutputs?: boolean;
}) {
  const { exporter, provider, telemetry } = createSpanHarness(
    options.level,
    options.telemetryOptions,
  );
  const runtimeContext = options.runtimeContext ?? {
    'conversation.id': 'session-1',
  };
  await generateText({
    model: createMockLanguageModel('gpt-test'),
    system: 'System instructions',
    prompt: 'Model input',
    maxRetries: 0,
    telemetry: {
      isEnabled: true,
      integrations: [telemetry],
      functionId: options.functionId ?? 'chat-session',
      ...(options.recordInputs !== undefined && {
        recordInputs: options.recordInputs,
      }),
      ...(options.recordOutputs !== undefined && {
        recordOutputs: options.recordOutputs,
      }),
      includeRuntimeContext: Object.fromEntries(
        Object.keys(runtimeContext).map((key) => [key, true]),
      ),
    },
    runtimeContext,
  });
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

function findSpanByOp(
  spans: ReturnType<InMemorySpanExporter['getFinishedSpans']>,
  operationName: string,
) {
  return spans.find(
    (span) => span.attributes['gen_ai.operation.name'] === operationName,
  );
}

function parseAttribute(value: unknown): unknown {
  expect(typeof value).toBe('string');
  return JSON.parse(value as string);
}

describe('KlexOpenTelemetry — model content', () => {
  it('exports model content in the GenAI parts format on chat spans at debug', async () => {
    const spans = await exportContentCall({ level: 'debug' });
    const chat = findSpanByOp(spans, 'chat');
    const attributes = chat?.attributes ?? {};

    expect(parseAttribute(attributes['gen_ai.system_instructions'])).toEqual([
      { type: 'text', content: 'System instructions' },
    ]);
    expect(parseAttribute(attributes['gen_ai.input.messages'])).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Model input' }] },
    ]);
    expect(parseAttribute(attributes['gen_ai.output.messages'])).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Model output' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('exports no content at advanced', async () => {
    const spans = await exportContentCall({ level: 'advanced' });
    const chat = findSpanByOp(spans, 'chat');
    const invokeAgent = findSpanByOp(spans, 'invoke_agent');
    const attributes = chat?.attributes ?? {};

    expect(attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(attributes['gen_ai.input.messages']).toBeUndefined();
    expect(attributes['gen_ai.output.messages']).toBeUndefined();
    expect(attributes['gen_ai.request.model']).toBe('gpt-test');
    expect(attributes['gen_ai.operation.name']).toBe('chat');
    expect(attributes['gen_ai.conversation.id']).toBe('session-1');
    expect(invokeAgent?.attributes['gen_ai.conversation.id']).toBeUndefined();
  });

  it('does not record content the caller opted out of', async () => {
    const spans = await exportContentCall({
      level: 'debug',
      recordInputs: false,
    });
    const attributes = findSpanByOp(spans, 'chat')?.attributes ?? {};

    expect(attributes['gen_ai.input.messages']).toBeUndefined();
    expect(attributes['gen_ai.output.messages']).toBeDefined();
  });
});

describe('KlexOpenTelemetry — Agent Observability spanType filtering', () => {
  it('marks only chat (languageModel) spans as recordable and suppresses invoke_agent/step duplicates at advanced', async () => {
    const spans = await exportContentCall({
      level: 'advanced',
      telemetryOptions: {
        agentName: '  Knuth  ',
        getAgentId: () => 'client-1',
      },
      runtimeContext: {
        'conversation.id': 'default',
        'conversation.epoch': 'cp-1',
      },
    });
    const invokeAgent = findSpanByOp(spans, 'invoke_agent');
    const step = findSpanByOp(spans, 'agent_step');
    const chat = findSpanByOp(spans, 'chat');

    expect(invokeAgent).toBeDefined();
    expect(step).toBeDefined();
    expect(chat).toBeDefined();

    expect(invokeAgent?.attributes['agento11y.record']).toBe(false);
    expect(invokeAgent?.attributes['gen_ai.conversation.id']).toBeUndefined();
    expect(invokeAgent?.attributes['gen_ai.agent.id']).toBeUndefined();

    expect(step?.attributes['agento11y.record']).toBe(false);
    expect(step?.attributes['gen_ai.conversation.id']).toBeUndefined();
    expect(step?.attributes['gen_ai.agent.id']).toBeUndefined();

    expect(chat?.attributes['agento11y.record']).toBe(true);
    expect(chat?.attributes['gen_ai.conversation.id']).toBe(
      'default:client-1:cp-1',
    );
    expect(chat?.attributes['gen_ai.agent.id']).toBe('client-1');
    expect(chat?.attributes['gen_ai.agent.name']).toBe('Knuth');
    expect(chat?.attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('keeps the marker next to content on chat spans at debug while keeping wrappers non-recorded', async () => {
    const spans = await exportContentCall({
      level: 'debug',
      telemetryOptions: {
        agentName: 'Knuth',
        getAgentId: () => 'client-1',
      },
    });
    const invokeAgent = findSpanByOp(spans, 'invoke_agent');
    const step = findSpanByOp(spans, 'agent_step');
    const chat = findSpanByOp(spans, 'chat');

    expect(invokeAgent?.attributes['agento11y.record']).toBe(false);
    expect(step?.attributes['agento11y.record']).toBe(false);
    expect(chat?.attributes['agento11y.record']).toBe(true);
    expect(chat?.attributes['gen_ai.agent.name']).toBe('Knuth');
    expect(chat?.attributes['gen_ai.input.messages']).toBeDefined();
  });

  it.each([
    'extension:io.stagewise/context-compaction',
    'extension:io.stagewise/episode-summary',
    'extension:core:instinct-classifier',
  ])(
    'excludes background housekeeping extension %s from Agent Observability',
    async (functionId) => {
      const spans = await exportContentCall({
        level: 'debug',
        functionId,
        telemetryOptions: {
          agentName: 'Knuth',
          getAgentId: () => 'client-1',
        },
        runtimeContext: {
          'conversation.id': 'default',
          'conversation.epoch': 'cp-1',
        },
      });
      const invokeAgent = findSpanByOp(spans, 'invoke_agent');
      const step = findSpanByOp(spans, 'agent_step');
      const chat = findSpanByOp(spans, 'chat');

      for (const span of [invokeAgent, step, chat]) {
        expect(span).toBeDefined();
        expect(span?.attributes['agento11y.record']).toBe(false);
        expect(span?.attributes['gen_ai.conversation.id']).toBeUndefined();
        expect(span?.attributes['gen_ai.agent.id']).toBeUndefined();
      }
      expect(chat?.attributes['klex.call.source']).toBe('extension');
      expect(chat?.attributes['klex.extension.id']).toBe(
        functionId.slice('extension:'.length),
      );
    },
  );

  it('records AI SDK execute_tool spans on normal calls and excludes them on housekeeping calls', async () => {
    const { exporter, provider, telemetry } = createSpanHarness('advanced', {
      agentName: 'Knuth',
      getAgentId: () => 'client-1',
    });
    const runToolCall = async (functionId: string) => {
      const model = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-test',
        doGenerate: async () => ({
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'lookup',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: {
            inputTokens: {
              total: 10,
              noCache: 10,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        }),
      });
      await generateText({
        model,
        prompt: 'run tool',
        maxRetries: 0,
        tools: {
          lookup: tool({
            description: 'lookup',
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          }),
        },
        telemetry: {
          isEnabled: true,
          integrations: [telemetry],
          functionId,
          includeRuntimeContext: {
            'conversation.id': true,
            'conversation.epoch': true,
          },
        },
        runtimeContext: {
          'conversation.id': 'default',
          'conversation.epoch': 'cp-tool',
        },
      });
    };

    try {
      await runToolCall('extension:memory');
      await provider.forceFlush();
      const recordedTool = findSpanByOp(
        exporter.getFinishedSpans(),
        'execute_tool',
      );
      expect(recordedTool).toBeDefined();
      expect(recordedTool?.attributes['agento11y.record']).toBe(true);
      expect(recordedTool?.attributes['gen_ai.conversation.id']).toBe(
        'default:client-1:cp-tool',
      );
      expect(recordedTool?.attributes['gen_ai.agent.id']).toBe('client-1');
      expect(recordedTool?.attributes['gen_ai.agent.name']).toBe('Knuth');

      exporter.reset();
      await runToolCall('extension:io.stagewise/episode-summary');
      await provider.forceFlush();
      const housekeepingTool = findSpanByOp(
        exporter.getFinishedSpans(),
        'execute_tool',
      );
      expect(housekeepingTool).toBeDefined();
      expect(housekeepingTool?.attributes['agento11y.record']).toBe(false);
      expect(
        housekeepingTool?.attributes['gen_ai.conversation.id'],
      ).toBeUndefined();
    } finally {
      await provider.shutdown();
    }
  });
});

describe('KlexOpenTelemetry — agent identity', () => {
  it('records the configured agent name and enrolled agent id on chat spans', async () => {
    let agentId: string | null = null;
    const { exporter, provider, telemetry } = createSpanHarness('advanced', {
      agentName: '  Klex  ',
      getAgentId: () => agentId,
    });
    const run = async (functionId: string) => {
      await generateText({
        model: createMockLanguageModel('gpt-test'),
        prompt: 'hello',
        maxRetries: 0,
        telemetry: {
          isEnabled: true,
          integrations: [telemetry],
          functionId,
        },
      });
    };

    await run('chat-session');
    agentId = 'client-1';
    await run('extension:vision');
    await provider.forceFlush();

    const chats = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    const [first, second] = chats;
    expect(first?.attributes['agento11y.record']).toBe(true);
    expect(first?.attributes['gen_ai.agent.name']).toBe('Klex');
    expect(first?.attributes['gen_ai.agent.id']).toBeUndefined();
    expect(first?.attributes['klex.call.source']).toBe('chat');
    expect(second?.attributes['agento11y.record']).toBe(true);
    expect(second?.attributes['gen_ai.agent.id']).toBe('client-1');
    expect(second?.attributes['gen_ai.agent.name']).toBe('Klex');
    expect(second?.attributes['klex.call.source']).toBe('extension');
    expect(second?.attributes['klex.extension.id']).toBe('vision');
    await provider.shutdown();
  });

  it('scopes the default conversation id by agent and epoch on chat spans only', async () => {
    let agentId: string | null = null;
    const { exporter, provider, telemetry } = createSpanHarness('advanced', {
      getAgentId: () => agentId,
      fallbackAgentId: 'instance-1',
    });
    const run = async (conversationId: string, conversationEpoch?: string) => {
      await generateText({
        model: createMockLanguageModel('gpt-test'),
        prompt: 'hello',
        maxRetries: 0,
        telemetry: {
          isEnabled: true,
          integrations: [telemetry],
          functionId: 'chat-session',
          includeRuntimeContext: {
            'conversation.id': true,
            ...(conversationEpoch !== undefined && {
              'conversation.epoch': true,
            }),
          },
        },
        runtimeContext: {
          'conversation.id': conversationId,
          ...(conversationEpoch !== undefined && {
            'conversation.epoch': conversationEpoch,
          }),
        },
      });
    };

    await run('default', 'boot-1');
    agentId = 'client-1';
    await run('default', 'cp-2');
    await run('child-uuid');
    await run('memory-uuid', 'ep-3');
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const chatIds = spans
      .filter((span) => span.attributes['gen_ai.operation.name'] === 'chat')
      .map((span) => span.attributes['gen_ai.conversation.id']);
    expect(chatIds).toEqual([
      'default:instance-1:boot-1',
      'default:client-1:cp-2',
      'child-uuid',
      'memory-uuid:ep-3',
    ]);
    for (const wrapper of spans.filter(
      (span) => span.attributes['gen_ai.operation.name'] !== 'chat',
    )) {
      expect(wrapper.attributes['agento11y.record']).toBe(false);
      expect(wrapper.attributes['gen_ai.conversation.id']).toBeUndefined();
    }
    await provider.shutdown();
  });
});

describe('GenAiIdentitySpanProcessor', () => {
  function createIdentityHarness(
    agentId: string | null,
    fallbackAgentId?: string,
    agentName?: string,
  ) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new GenAiIdentitySpanProcessor({
          agentName,
          getAgentId: () => agentId,
          fallbackAgentId,
        }),
        new SimpleSpanProcessor(exporter),
      ],
    });
    return { exporter, provider, tracer: provider.getTracer('test') };
  }

  it('marks Klex tool spans with Agent Observability identity and bounded epoch', async () => {
    const { exporter, provider, tracer } = createIdentityHarness(
      'client-1',
      undefined,
      '  Knuth  ',
    );
    tracer
      .startSpan('execute_tool read_file', {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'read_file',
          'klex.session.id': 'session-1',
          'klex.conversation.epoch': 'ep-42',
        },
      })
      .end();
    await provider.forceFlush();

    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attributes['agento11y.record']).toBe(true);
    expect(attributes['gen_ai.agent.id']).toBe('client-1');
    expect(attributes['gen_ai.agent.name']).toBe('Knuth');
    expect(attributes['gen_ai.conversation.id']).toBe('session-1:ep-42');
    await provider.shutdown();
  });

  it.each([
    {
      agentId: 'client-1',
      epoch: 'cp-9',
      expected: 'default:client-1:cp-9',
    },
    {
      agentId: null,
      epoch: 'cp-9',
      expected: 'default:instance-1:cp-9',
    },
    {
      agentId: 'client-1',
      epoch: undefined,
      expected: 'default:client-1',
    },
  ])(
    'scopes default tool spans by agent and epoch ($expected)',
    async ({ agentId, epoch, expected }) => {
      const { exporter, provider, tracer } = createIdentityHarness(
        agentId,
        'instance-1',
      );
      tracer
        .startSpan('execute_tool read_file', {
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'klex.session.id': 'default',
            ...(epoch !== undefined && { 'klex.conversation.epoch': epoch }),
          },
        })
        .end();
      await provider.forceFlush();

      const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
      expect(attributes['gen_ai.conversation.id']).toBe(expected);
      expect(attributes['klex.session.id']).toBe('default');
      await provider.shutdown();
    },
  );

  it('omits the agent id before enrollment', async () => {
    const { exporter, provider, tracer } = createIdentityHarness(null);
    tracer
      .startSpan('execute_tool read_file', {
        attributes: { 'gen_ai.operation.name': 'execute_tool' },
      })
      .end();
    await provider.forceFlush();

    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attributes['agento11y.record']).toBe(true);
    expect(attributes['gen_ai.agent.id']).toBeUndefined();
    expect(attributes['gen_ai.conversation.id']).toBeUndefined();
    await provider.shutdown();
  });

  it('leaves AI SDK spans (both true and false) and non-GenAI spans unchanged', async () => {
    const { exporter, provider, tracer } = createIdentityHarness('client-1');
    tracer
      .startSpan('chat gpt-test', {
        attributes: {
          'gen_ai.operation.name': 'chat',
          'agento11y.record': true,
          'gen_ai.conversation.id': 'session-sdk',
        },
      })
      .end();
    tracer
      .startSpan('invoke_agent gpt-test', {
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'agento11y.record': false,
          'klex.session.id': 'default',
        },
      })
      .end();
    tracer
      .startSpan('turn', { attributes: { 'klex.session.id': 'session-1' } })
      .end();
    await provider.forceFlush();

    const [sdkChatSpan, sdkWrapperSpan, turnSpan] = exporter.getFinishedSpans();
    expect(sdkChatSpan?.attributes['gen_ai.agent.id']).toBeUndefined();
    expect(sdkChatSpan?.attributes['gen_ai.conversation.id']).toBe(
      'session-sdk',
    );
    expect(sdkWrapperSpan?.attributes['agento11y.record']).toBe(false);
    expect(
      sdkWrapperSpan?.attributes['gen_ai.conversation.id'],
    ).toBeUndefined();
    expect(turnSpan?.attributes['agento11y.record']).toBeUndefined();
    expect(turnSpan?.attributes['gen_ai.conversation.id']).toBeUndefined();
    await provider.shutdown();
  });
});

describe('instinct generation cancellation telemetry', () => {
  it.each(
    (['timeout', 'caller', 'deadline'] as const).flatMap((cause) =>
      (['resolve', 'reject', 'never'] as const).map((late) => ({
        cause,
        late,
      })),
    ),
  )('closes $cause once and ignores late $late', async ({ cause, late }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const {
      exporter,
      provider,
      telemetry: spans,
    } = createSpanHarness('advanced');
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));
    vi.stubGlobal('AI_SDK_TELEMETRY_INTEGRATIONS', [telemetry, spans]);
    let resolve!: (value: LanguageModelV4GenerateResult) => void;
    let reject!: (error: Error) => void;
    const transport = vi.fn(
      () =>
        new Promise<LanguageModelV4GenerateResult>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const response: LanguageModelV4GenerateResult = {
      content: [{ type: 'text', text: '{"q0":1}' }],
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
    };
    const stalled: InstinctModelCandidate = {
      status: 'ready',
      api: 'generation',
      providerType: 'openai',
      entry: {
        api: 'generation',
        providerId: 'test',
        modelId: 'stalled',
        attemptTimeoutMs: cause === 'timeout' ? 10 : 1000,
      },
      model: new MockLanguageModelV4({
        modelId: 'stalled',
        doGenerate: transport,
      }),
    };
    const fallbackCall = vi.fn(async () => response);
    const fallback: InstinctModelCandidate = {
      ...stalled,
      entry: { ...stalled.entry, modelId: 'fallback' },
      model: new MockLanguageModelV4({
        modelId: 'fallback',
        doGenerate: fallbackCall,
      }),
    };
    const controller = new AbortController();
    const onUsage = vi.fn();
    try {
      const pending = executeInstinctClassification(
        {
          entries: [
            {
              extensionIdentifier: 'test',
              request: {
                prompt: 'Classify facts',
                keys: { flag: { type: 'boolean', description: 'Flag?' } },
              },
            },
          ],
          system: 'Classify facts',
          prompt: 'The flag is true.',
          state: 'The flag is true.',
          schema: z.object({ q0: z.number().min(0).max(1) }),
          questions: {},
          signal: controller.signal,
          deadlineAt: performance.now() + (cause === 'deadline' ? 10 : 1000),
        },
        {
          candidates: [stalled, fallback],
          functionId: 'extension:core:instinct-classifier',
          onUsage,
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(transport).toHaveBeenCalledTimes(1);
      if (cause === 'caller') controller.abort(new Error('cancelled'));
      else await vi.advanceTimersByTimeAsync(11);
      const outcome = (await pending).get('test');
      // The outer cancellation race settles before the SDK's terminal hooks.
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome?.status).toBe(
        cause === 'timeout' ? 'ok' : cause === 'caller' ? 'aborted' : 'timeout',
      );
      await provider.forceFlush();
      expect(
        records.filter((record) => record.modelId === 'stalled'),
      ).toHaveLength(1);
      expect(records[0]).toMatchObject({
        api: 'generation',
        isError: true,
        inputTokens: 0,
        outputTokens: 0,
        tokenUsageReported: false,
        cacheUsageReported: false,
      });
      expect(records).toHaveLength(cause === 'timeout' ? 2 : 1);
      expect(fallbackCall).toHaveBeenCalledTimes(cause === 'timeout' ? 1 : 0);
      expect(onUsage).toHaveBeenCalledTimes(cause === 'timeout' ? 1 : 0);
      const before = records.slice();
      const spanCount = exporter.getFinishedSpans().length;
      if (late === 'resolve') resolve(response);
      else if (late === 'reject') reject(new Error('late private failure'));
      await vi.advanceTimersByTimeAsync(0);
      await provider.forceFlush();
      expect(records).toEqual(before);
      expect(exporter.getFinishedSpans()).toHaveLength(spanCount);
      expect(
        (telemetry as unknown as { callStates: Map<string, unknown> })
          .callStates.size,
      ).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      await provider.shutdown();
    }
  });
});

describe('evaluation telemetry', () => {
  it.each([{ inputTokens: 0, outputTokens: 0 }, undefined, { inputTokens: 7 }])(
    'preserves genuine usage availability through the SDK (%j)',
    async (usage) => {
      const {
        exporter,
        provider,
        telemetry: spans,
      } = createSpanHarness('advanced');
      const telemetry = createTelemetry();
      const records: ModelCallRecord[] = [];
      telemetry.setModelCallSink((record) => records.push(record));
      const model: EvaluationModel = {
        specificationVersion: 'v4',
        provider: 'typesafe.evaluation',
        modelId: 'requested',
        supportedQuestionTypes: ['boolean'],
        doEvaluate: async () => ({
          answers: { fact: { type: 'boolean', probability: 1 } },
          usage,
          warnings: [{ type: 'other', message: 'private warning' }],
          response: { modelId: 'returned', id: 'response' },
        }),
      };
      try {
        await evaluate({
          model,
          state: 'private state',
          questions: {
            fact: { type: 'boolean', instructions: 'private question' },
          },
          maxRetries: 0,
          telemetry: {
            integrations: [telemetry, spans],
            functionId: 'extension:core:instinct-classifier',
            recordInputs: true,
            recordOutputs: true,
          },
        });
        await provider.forceFlush();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          api: 'evaluation',
          source: 'extension',
          sessionId: null,
          modelId: 'requested',
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          tokenUsageReported:
            usage?.inputTokens !== undefined &&
            usage?.outputTokens !== undefined,
          cacheUsageReported: false,
        });
        const span = exporter.getFinishedSpans()[0];
        expect(span?.attributes['agento11y.record']).toBe(false);
        expect(span?.attributes['gen_ai.conversation.id']).toBeUndefined();
        expect(span?.attributes['gen_ai.response.model']).toBe('returned');
        expect(span?.attributes['gen_ai.usage.input_tokens']).toBe(
          usage?.inputTokens,
        );
        expect(span?.attributes['gen_ai.usage.output_tokens']).toBe(
          usage?.outputTokens,
        );
        expect(span?.attributes['klex.evaluation.warning_count']).toBe(1);
        expect(JSON.stringify(span?.attributes)).not.toContain('private');
      } finally {
        await provider.shutdown();
      }
    },
  );

  it.each(['Error', 'AbortError'])(
    'sanitizes %s diagnostics and ignores late duplicate errors',
    async (errorName) => {
      const {
        exporter,
        provider,
        telemetry: spans,
      } = createSpanHarness('debug');
      const telemetry = createTelemetry();
      const records: ModelCallRecord[] = [];
      telemetry.setModelCallSink((record) => records.push(record));
      const model: EvaluationModel = {
        specificationVersion: 'v4',
        provider: 'typesafe.evaluation',
        modelId: 'native',
        supportedQuestionTypes: ['boolean'],
        doEvaluate: async () => {
          const error = new Error('private request and credential');
          error.name = errorName;
          throw error;
        },
      };
      try {
        await expect(
          evaluate({
            model,
            state: 'private state',
            questions: { fact: { type: 'boolean', instructions: 'fact' } },
            maxRetries: 0,
            telemetry: {
              integrations: [telemetry, spans],
              recordInputs: false,
              recordOutputs: false,
            },
          }),
        ).rejects.toThrow();
        const late = {
          callId: records[0]?.id,
          error: new Error('late private failure'),
        };
        telemetry.onError(late);
        spans.onError(late);
        await provider.forceFlush();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          api: 'evaluation',
          isError: true,
          tokenUsageReported: false,
          cacheUsageReported: false,
        });
        expect(exporter.getFinishedSpans()).toHaveLength(1);
        expect(exporter.getFinishedSpans()[0]?.attributes['klex.outcome']).toBe(
          errorName === 'AbortError' ? 'aborted' : 'error',
        );
        expect(
          JSON.stringify(exporter.getFinishedSpans()[0]?.events),
        ).not.toContain('private');
      } finally {
        await provider.shutdown();
      }
    },
  );
});

describe('ModelCallUsageTelemetry — model ID propagation', () => {
  it('emits exactly one terminal model-call record per generation lifecycle', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const start = (callId: string) =>
      telemetry.onStart(
        makeStartEvent({
          callId,
          operationId: 'ai.generateText',
          provider: 'openai',
          modelId: 'gpt-4o',
          functionId: 'chat-session',
        }),
      );
    const end = (callId: string) =>
      telemetry.onEnd(
        makeEndEvent({
          callId,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      );

    start('call-error-first');
    telemetry.onError({ callId: 'call-error-first', error: new Error('boom') });
    end('call-error-first');
    start('call-end-first');
    end('call-end-first');
    telemetry.onError({ callId: 'call-end-first', error: new Error('late') });
    start('call-independent');
    end('call-independent');
    start('call-independent');
    end('call-independent');

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.id)).toEqual([
      'call-error-first',
      'call-end-first',
      'call-independent',
      'call-independent',
    ]);
  });

  it('records explicit provider and native model identity', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-full-id';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-001',
          'conversation.providerType': 'openai',
          'conversation.providerId': 'work',
          'conversation.modelId': 'gpt-4o',
        },
        functionId: 'chat-session',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.providerType).toBe('openai');
    expect(record.providerId).toBe('work');
    expect(record.endpointId).toBeNull();
    expect(record.modelId).toBe('gpt-4o');
    expect(record.sessionId).toBe('session-001');
    expect(record.source).toBe('chat');
  });

  it('records explicit provider identity for extension calls', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-two-seg';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.generateText',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4',
        runtimeContext: {
          'conversation.id': 'session-002',
          'conversation.providerType': 'anthropic',
          'conversation.providerId': 'personal',
          'conversation.modelId': 'claude-sonnet-4',
        },
        functionId: 'extension:context-compaction',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.providerType).toBe('anthropic');
    expect(record.providerId).toBe('personal');
    expect(record.endpointId).toBeNull();
    expect(record.modelId).toBe('claude-sonnet-4');
    expect(record.source).toBe('extension');
    expect(record.extensionId).toBe('context-compaction');
  });

  // ---------------------------------------------------------------------------
  // REGRESSION: The AI SDK's createRestrictedTelemetryDispatcher strips
  // runtimeContext keys unless telemetry.includeRuntimeContext explicitly
  // allow-lists them. If a caller forgets includeRuntimeContext, the
  // runtimeContext arrives as {}. KlexTelemetry must fall back to the AI
  // SDK's own provider/modelId fields instead of logging "unknown".
  // ---------------------------------------------------------------------------

  it('falls back to AI SDK provider/modelId when runtimeContext is stripped (empty)', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-stripped';
    // Simulate the restricted telemetry dispatcher having stripped
    // all runtimeContext keys.
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {},
        functionId: 'chat-session',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.modelId).toBe('gpt-4o');
    expect(record.providerId).toBe('openai');
    expect(record.modelId).not.toBe('unknown');
  });

  it('falls back to AI SDK provider/modelId when runtimeContext is undefined', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-undefined-ctx';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.generateText',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4',
        runtimeContext: undefined,
        functionId: 'extension:vision',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.modelId).toBe('claude-sonnet-4');
    expect(record.providerId).toBe('anthropic');
    expect(record.modelId).not.toBe('unknown');
  });

  it('handles model IDs containing colons in the model segment', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-colon-model';
    // e.g. providerId=openai, endpointId=local, modelId=gpt-4o:2024-08-06
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-003',
          'conversation.providerType': 'openai',
          'conversation.providerId': 'local',
          'conversation.modelId': 'gpt-4o:2024-08-06',
        },
        functionId: 'chat-session',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.providerType).toBe('openai');
    expect(record.providerId).toBe('local');
    expect(record.endpointId).toBeNull();
    expect(record.modelId).toBe('gpt-4o:2024-08-06');
  });

  it('forwards correct record on abort', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-abort';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-004',
          'conversation.providerType': 'openai',
          'conversation.providerId': 'work',
          'conversation.modelId': 'gpt-4o',
        },
        functionId: 'chat-session',
      }),
    );

    telemetry.onAbort(
      makeAbortEvent({
        callId,
        steps: [],
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.providerType).toBe('openai');
    expect(record.providerId).toBe('work');
    expect(record.modelId).toBe('gpt-4o');
    expect(record.finishReason).toBe('aborted');
    expect(record.isError).toBe(true);
    expect(record.errorType).toBe('aborted');
  });

  it('forwards correct record on error', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-error';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.generateText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-005',
          'conversation.providerType': 'openai',
          'conversation.providerId': 'custom',
          'conversation.modelId': 'gpt-4o',
        },
        functionId: 'extension:audio',
      }),
    );

    telemetry.onError({
      callId,
      error: new Error('rate_limit_exceeded'),
    });

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.providerType).toBe('openai');
    expect(record.providerId).toBe('custom');
    expect(record.endpointId).toBeNull();
    expect(record.modelId).toBe('gpt-4o');
    expect(record.finishReason).toBe('error');
    expect(record.isError).toBe(true);
    expect(record.errorType).toBe('Error');
    expect(record.source).toBe('extension');
    expect(record.extensionId).toBe('audio');
  });

  it('ignores non-text-generation operations', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    telemetry.onStart(
      makeStartEvent({
        callId: 'call-embed',
        operationId: 'ai.embed',
        provider: 'openai',
        modelId: 'text-embedding-3-small',
        runtimeContext: {},
      }),
    );

    // onEnd would not find a call state, so no record is forwarded
    telemetry.onEnd(
      makeEndEvent({
        callId: 'call-embed',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 0 },
      }),
    );

    expect(records).toHaveLength(0);
  });

  it('forwards cache token details in the record', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-cache';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4',
        runtimeContext: {
          'conversation.id': 'session-006',
          'conversation.modelId': 'anthropic:claude-sonnet-4',
        },
        functionId: 'chat-session',
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          inputTokenDetails: {
            cacheReadTokens: 300,
            cacheWriteTokens: 100,
          },
        },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.inputCacheWriteTokens).toBe(100);
    expect(record.inputCacheReadTokens).toBe(300);
  });

  // ---------------------------------------------------------------------------
  // ttftMs / totalDurationMs propagation through onLanguageModelCallEnd
  // ---------------------------------------------------------------------------

  it('propagates ttftMs and totalDurationMs from onLanguageModelCallEnd to the record', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-perf';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-perf',
          'conversation.modelId': 'openai:gpt-4o',
        },
        functionId: 'chat-session',
      }),
    );

    // onLanguageModelCallEnd fires when the 'finish' chunk arrives —
    // before onEnd. It sets state.ttftMs and state.totalDurationMs.
    telemetry.onLanguageModelCallEnd(
      makeCallEndEvent({
        callId,
        provider: 'openai',
        modelId: 'gpt-4o',
        responseId: 'resp-001',
        performance: {
          responseTimeMs: 1500,
          timeToFirstOutputMs: 250,
        },
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.ttftMs).toBe(250);
    expect(record.totalDurationMs).toBe(1500);
  });

  it('ttftMs is null and totalDurationMs falls back to wall-clock when onLanguageModelCallEnd is not called', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-no-perf';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.streamText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-no-perf',
          'conversation.modelId': 'openai:gpt-4o',
        },
        functionId: 'chat-session',
      }),
    );

    // No onLanguageModelCallEnd — simulates abort before finish chunk.
    telemetry.onAbort(
      makeAbortEvent({
        callId,
        steps: [],
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.ttftMs).toBeNull();
    // totalDurationMs falls back to wall-clock (now - spanStartTime).
    expect(record.totalDurationMs).not.toBeNull();
    expect(record.totalDurationMs!).toBeGreaterThanOrEqual(0);
  });

  it('ttftMs is null when performance object lacks timeToFirstOutputMs', () => {
    const telemetry = createTelemetry();
    const records: ModelCallRecord[] = [];
    telemetry.setModelCallSink((record) => records.push(record));

    const callId = 'call-partial-perf';
    telemetry.onStart(
      makeStartEvent({
        callId,
        operationId: 'ai.generateText',
        provider: 'openai',
        modelId: 'gpt-4o',
        runtimeContext: {
          'conversation.id': 'session-partial',
          'conversation.modelId': 'openai:gpt-4o',
        },
        functionId: 'extension:context-compaction',
      }),
    );

    telemetry.onLanguageModelCallEnd(
      makeCallEndEvent({
        callId,
        provider: 'openai',
        modelId: 'gpt-4o',
        responseId: 'resp-002',
        performance: {
          responseTimeMs: 3000,
          // timeToFirstOutputMs intentionally absent — generateText
          // (non-streaming) does not produce per-token timing.
        },
      }),
    );

    telemetry.onEnd(
      makeEndEvent({
        callId,
        finishReason: 'stop',
        usage: { inputTokens: 200, outputTokens: 100 },
      }),
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.ttftMs).toBeNull();
    expect(record.totalDurationMs).toBe(3000);
  });
});
