import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import type { ModelCallRecord } from '@/model-call-logger';
import { createTelemetrySpanProcessor } from '@/telemetry-manager';

import {
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
type OtelStartEvent = Parameters<KlexOpenTelemetry['onStart']>[0];
type OtelEndEvent = Parameters<KlexOpenTelemetry['onEnd']>[0];

function makeStartEvent(event: Record<string, unknown>): StartEvent {
  return event as unknown as StartEvent;
}

function makeEndEvent(event: Record<string, unknown>): EndEvent {
  return event as unknown as EndEvent;
}

function makeOtelStartEvent(event: Record<string, unknown>): OtelStartEvent {
  return event as unknown as OtelStartEvent;
}

/** Fields `@ai-sdk/otel` reads from a generateText end event. */
function makeOtelEndEvent(event: Record<string, unknown>): OtelEndEvent {
  return {
    finalStep: { reasoning: [] },
    toolCalls: [],
    files: [],
    ...event,
  } as unknown as OtelEndEvent;
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

async function exportContentCall(options: { level: 'advanced' | 'debug' }) {
  const { exporter, provider, telemetry } = createSpanHarness(options.level);

  telemetry.onStart(
    makeOtelStartEvent({
      callId: 'content-call',
      operationId: 'ai.generateText',
      provider: 'openai',
      modelId: 'gpt-test',
      functionId: 'chat-session',
      instructions: 'System instructions',
      messages: [{ role: 'user', content: 'Model input' }],
      runtimeContext: { 'conversation.id': 'session-1' },
    }),
  );
  telemetry.onEnd(
    makeOtelEndEvent({
      callId: 'content-call',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3 },
      text: 'Model output',
    }),
  );
  await provider.forceFlush();
  const span = exporter.getFinishedSpans()[0];
  await provider.shutdown();
  return span?.attributes ?? {};
}

function parseAttribute(value: unknown): unknown {
  expect(typeof value).toBe('string');
  return JSON.parse(value as string);
}

describe('KlexOpenTelemetry — model content', () => {
  it('exports model content in the GenAI parts format at debug', async () => {
    const attributes = await exportContentCall({ level: 'debug' });

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
    const attributes = await exportContentCall({ level: 'advanced' });

    expect(attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(attributes['gen_ai.input.messages']).toBeUndefined();
    expect(attributes['gen_ai.output.messages']).toBeUndefined();
    expect(attributes['gen_ai.request.model']).toBe('gpt-test');
    expect(attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(attributes['gen_ai.conversation.id']).toBe('session-1');
  });

  it('does not record content the caller opted out of', async () => {
    const { exporter, provider, telemetry } = createSpanHarness('debug');
    telemetry.onStart(
      makeOtelStartEvent({
        callId: 'opt-out',
        operationId: 'ai.generateText',
        provider: 'openai',
        modelId: 'gpt-test',
        messages: [{ role: 'user', content: 'secret' }],
        recordInputs: false,
      }),
    );
    telemetry.onEnd(
      makeOtelEndEvent({
        callId: 'opt-out',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        text: 'visible',
      }),
    );
    await provider.forceFlush();
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    await provider.shutdown();

    expect(attributes['gen_ai.input.messages']).toBeUndefined();
    expect(attributes['gen_ai.output.messages']).toBeDefined();
  });
});

describe('KlexOpenTelemetry — Agent Observability marker', () => {
  it('marks every model span without exporting content at advanced', async () => {
    const attributes = await exportContentCall({ level: 'advanced' });

    expect(attributes['agento11y.record']).toBe(true);
    expect(attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('keeps the marker next to content at debug', async () => {
    const attributes = await exportContentCall({ level: 'debug' });

    expect(attributes['agento11y.record']).toBe(true);
    expect(attributes['gen_ai.input.messages']).toBeDefined();
  });
});

describe('KlexOpenTelemetry — agent identity', () => {
  it('records the configured agent name and enrolled agent id', async () => {
    let agentId: string | null = null;
    const { exporter, provider, telemetry } = createSpanHarness('advanced', {
      agentName: '  Klex  ',
      getAgentId: () => agentId,
    });
    const run = (callId: string, functionId: string) => {
      telemetry.onStart(
        makeOtelStartEvent({
          callId,
          operationId: 'ai.generateText',
          provider: 'openai',
          modelId: 'gpt-test',
          functionId,
        }),
      );
      telemetry.onEnd(
        makeOtelEndEvent({
          callId,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      );
    };

    run('before-enrollment', 'chat-session');
    agentId = 'client-1';
    run('after-enrollment', 'extension:vision');
    await provider.forceFlush();

    const [first, second] = exporter.getFinishedSpans();
    expect(first?.attributes['gen_ai.agent.name']).toBe('Klex');
    expect(first?.attributes['gen_ai.agent.id']).toBeUndefined();
    expect(first?.attributes['klex.call.source']).toBe('chat');
    expect(second?.attributes['gen_ai.agent.id']).toBe('client-1');
    expect(second?.attributes['gen_ai.agent.name']).toBe('Klex');
    expect(second?.attributes['klex.call.source']).toBe('extension');
    expect(second?.attributes['klex.extension.id']).toBe('vision');
    await provider.shutdown();
  });
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
