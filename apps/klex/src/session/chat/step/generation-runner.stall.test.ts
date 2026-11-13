import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Span } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ExtendedUIMessage } from '../message-types';
import { testLogger as logger } from '../test-helpers';
import type { AgentTools } from '../tools';
import { ModelFallbackManager } from '../utils/model-fallback-manager';
import { GenerationRunner } from './generation-runner';

// Real streamText and UI stream conversion against a scripted provider, so
// the watchdog sees the same chunks it sees in production.

type Script = (
  emit: (part: LanguageModelV4StreamPart) => void,
  at: (ms: number, fn: () => void) => void,
  close: () => void,
) => void;

const usage = (outputTokens: number) => ({
  inputTokens: {
    total: 40_000,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
});

function scriptedModel(script: Script, opts: { headersAfterMs?: number } = {}) {
  const signals: AbortSignal[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      signals.push(abortSignal!);
      if (opts.headersAfterMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.headersAfterMs);
          abortSignal!.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(abortSignal!.reason);
          });
        });
      }
      const timers: ReturnType<typeof setTimeout>[] = [];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            abortSignal!.addEventListener('abort', () => {
              timers.forEach(clearTimeout);
              controller.error(abortSignal!.reason);
            });
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'response-metadata', id: 'resp' });
            script(
              (part) => controller.enqueue(part),
              (ms, fn) => timers.push(setTimeout(fn, ms)),
              () => controller.close(),
            );
          },
        }),
      };
    },
  });
  return { model, signals };
}

function makeSpan() {
  const events: Array<{ name: string; attributes?: Record<string, unknown> }> =
    [];
  const attributes = new Map<string, unknown>();
  const span = {
    addEvent: (name: string, eventAttributes?: Record<string, unknown>) => {
      events.push({ name, attributes: eventAttributes });
    },
    setAttribute: (key: string, value: unknown) => attributes.set(key, value),
    setAttributes: vi.fn(),
    recordException: vi.fn(),
  } as unknown as Span;
  return { span, events, attributes };
}

function makeRunner(model: MockLanguageModelV4, messages: ExtendedUIMessage[]) {
  const { span, events, attributes } = makeSpan();
  const fallbackManager = new ModelFallbackManager({
    logger: logger as ModuleLogger,
    span: trace.getTracer('test').startSpan('test'),
    sessionId: 'test-session',
    getChatModels: () => ['gemini', 'gpt'] as never,
  });
  const runner = new GenerationRunner({
    logger,
    sessionId: 'test-session',
    stepSpan: span,
    modelMessages: [{ role: 'user', content: 'hello' }],
    messages,
    tools: {} as AgentTools,
    fallbackManager,
    turnInitialFallbackIndex: 0,
    compacted: false,
    model,
    modelContext: {
      providerType: 'google-generative',
      providerId: 'google',
      modelId: 'gemini',
    },
    streamDeadlines: { firstOutputMs: 180_000, idleMs: 120_000 },
    extensionSystemPromptParts: [],
    basePrompt: 'system',
  });
  return { runner, events, attributes, fallbackManager };
}

const userMessage: ExtendedUIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
};

describe('GenerationRunner — stream watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back from a stream that burns tokens without usable parts until finish length', async () => {
    const { model, signals } = scriptedModel((emit, at, close) => {
      // An opened but empty reasoning block, empty deltas, and nothing else:
      // the 65,536-token, ~500 s generations of KLEX-86.
      emit({ type: 'reasoning-start', id: 'r' });
      for (let ms = 5_000; ms < 500_000; ms += 5_000)
        at(ms, () => emit({ type: 'reasoning-delta', id: 'r', delta: '' }));
      at(500_000, () => {
        emit({ type: 'reasoning-end', id: 'r' });
        emit({
          type: 'finish',
          finishReason: { unified: 'length', raw: 'MAX_TOKENS' },
          usage: usage(65_536),
        });
        close();
      });
    });
    const messages = [userMessage];
    const { runner, events, attributes, fallbackManager } = makeRunner(
      model,
      messages,
    );

    const pending = runner.run();
    await vi.advanceTimersByTimeAsync(180_000);
    const result = await pending;

    expect(result).toMatchObject({
      modelFallbackOccurred: true,
      forceNextStep: false,
      generationFailed: false,
      fatalError: false,
      requestRejected: false,
    });
    expect(attributes.get('step.errorClassification')).toBe(
      'generation stalled (first-output)',
    );
    expect(fallbackManager.getFallbackIndex()).toBe(1);
    expect(messages).toEqual([userMessage]);
    expect(signals[0]!.aborted).toBe(true);
    const stalled = events.find((e) => e.name === 'step.generation_stalled');
    expect(stalled?.attributes).toMatchObject({
      'generation.stall.stage': 'first-output',
      'generation.stall.elapsedMs': 180_000,
      'generation.stall.budgetMs': 180_000,
      'generation.timeToResponseMs': 0,
    });
    expect(events.some((e) => e.name === 'step.first_output_received')).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back from a request whose response headers never arrive', async () => {
    const { model } = scriptedModel(() => {}, { headersAfterMs: 300_000 });
    const messages = [userMessage];
    const { runner, events } = makeRunner(model, messages);

    const pending = runner.run();
    await vi.advanceTimersByTimeAsync(180_000);
    const result = await pending;

    expect(result.modelFallbackOccurred).toBe(true);
    expect(messages).toEqual([userMessage]);
    const stalled = events.find((e) => e.name === 'step.generation_stalled');
    expect(stalled?.attributes).toMatchObject({
      'generation.stall.stage': 'response',
      'generation.stall.elapsedMs': 180_000,
    });
    expect(stalled?.attributes).not.toHaveProperty(
      'generation.timeToResponseMs',
    );
  });

  it('keeps a slow stream alive while it produces usable output', async () => {
    const { model } = scriptedModel((emit, at, close) => {
      emit({ type: 'text-start', id: 't' });
      for (let ms = 100_000; ms <= 600_000; ms += 100_000)
        at(ms, () => emit({ type: 'text-delta', id: 't', delta: 'word ' }));
      at(600_000, () => {
        emit({ type: 'text-end', id: 't' });
        emit({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'STOP' },
          usage: usage(12),
        });
        close();
      });
    });
    const messages = [userMessage];
    const { runner, events } = makeRunner(model, messages);

    const pending = runner.run();
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await pending;

    expect(result.modelFallbackOccurred).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'word '.repeat(6) }),
    );
    expect(
      events.find((e) => e.name === 'step.first_output_received')?.attributes,
    ).toMatchObject({
      'generation.timeToResponseMs': 0,
      'generation.timeToFirstOutputMs': 100_000,
    });
    expect(
      events.find((e) => e.name === 'step.generation_finished')?.attributes,
    ).toMatchObject({
      'generation.finishReason': 'stop',
      'generation.timeToFirstOutputMs': 100_000,
    });
  });

  it('salvages output and falls back when a stream goes idle after output', async () => {
    const { model } = scriptedModel((emit, at) => {
      emit({ type: 'text-start', id: 't' });
      at(1_000, () => emit({ type: 'text-delta', id: 't', delta: 'Partial' }));
    });
    const messages = [userMessage];
    const { runner, events } = makeRunner(model, messages);

    const pending = runner.run();
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await pending;

    expect(result).toMatchObject({
      modelFallbackOccurred: true,
      forceNextStep: true,
    });
    expect(messages).toHaveLength(2);
    expect(
      events.find((e) => e.name === 'step.generation_stalled')?.attributes,
    ).toMatchObject({
      'generation.stall.stage': 'idle',
      'generation.stall.elapsedMs': 121_000,
      'generation.stall.budgetMs': 120_000,
      'generation.timeToFirstOutputMs': 1_000,
    });
  });

  it('treats a caller cancellation as an abort, not a stall', async () => {
    const { model } = scriptedModel(() => {});
    const messages = [userMessage];
    const { runner, events, fallbackManager } = makeRunner(model, messages);

    const pending = runner.run();
    await vi.advanceTimersByTimeAsync(10_000);
    runner.abort('interrupt');
    const result = await pending;

    expect(result.modelFallbackOccurred).toBe(false);
    expect(fallbackManager.getFallbackIndex()).toBe(0);
    expect(events.some((e) => e.name === 'step.generation_stalled')).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
