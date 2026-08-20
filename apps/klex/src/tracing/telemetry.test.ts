import { trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import type { ModelCallRecord } from '@/model-call-logger';

import { createKlexTelemetry, type KlexTelemetry } from './telemetry';

const tracer = trace.getTracer('test');

function createTelemetry(): KlexTelemetry {
  return createKlexTelemetry(tracer);
}

// Cast helpers — the AI SDK event types are large unions with many
// required fields we don't use. KlexTelemetry only reads a small subset,
// so we cast through `unknown` to avoid constructing full mock objects.
type StartEvent = Parameters<KlexTelemetry['onStart']>[0];
type EndEvent = Parameters<KlexTelemetry['onEnd']>[0];
type AbortEvent = Parameters<KlexTelemetry['onAbort']>[0];
type CallEndEvent = Parameters<KlexTelemetry['onLanguageModelCallEnd']>[0];

function makeStartEvent(event: Record<string, unknown>): StartEvent {
  return event as unknown as StartEvent;
}

function makeEndEvent(event: Record<string, unknown>): EndEvent {
  return event as unknown as EndEvent;
}

function makeAbortEvent(event: Record<string, unknown>): AbortEvent {
  return event as unknown as AbortEvent;
}

function makeCallEndEvent(event: Record<string, unknown>): CallEndEvent {
  return event as unknown as CallEndEvent;
}

describe('KlexTelemetry — model ID propagation', () => {
  it('extracts providerId, endpointId, modelId from a full klex ModelId', () => {
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
          'conversation.modelId': 'openai:custom-endpoint:gpt-4o',
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
    expect(record.providerId).toBe('openai');
    expect(record.endpointId).toBe('custom-endpoint');
    expect(record.modelId).toBe('gpt-4o');
    expect(record.sessionId).toBe('session-001');
    expect(record.source).toBe('chat');
  });

  it('extracts providerId and modelId from a two-segment ModelId (no endpoint)', () => {
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
          'conversation.modelId': 'anthropic:claude-sonnet-4',
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
    expect(record.providerId).toBe('anthropic');
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
          'conversation.modelId': 'openai:local:gpt-4o:2024-08-06',
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
    expect(record.providerId).toBe('openai');
    expect(record.endpointId).toBe('local');
    // Everything after the second colon is the model ID
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
          'conversation.modelId': 'openai:gpt-4o',
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
    expect(record.providerId).toBe('openai');
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
          'conversation.modelId': 'openai:custom:gpt-4o',
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
    expect(record.providerId).toBe('openai');
    expect(record.endpointId).toBe('custom');
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
