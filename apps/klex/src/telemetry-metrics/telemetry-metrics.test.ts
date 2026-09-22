import {
  DataPointType,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it, vi } from 'vitest';

import { interactionQueueOverflowed } from './activity';
import { createTelemetryMetrics } from './telemetry-metrics';

class FakeExporter implements PushMetricExporter {
  readonly exports: unknown[] = [];
  shutdownCount = 0;

  export(
    metrics: Parameters<PushMetricExporter['export']>[0],
    callback: Parameters<PushMetricExporter['export']>[1],
  ): void {
    this.exports.push(metrics);
    callback({ code: 0 });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}

interface FlatMetric {
  name: string;
  unit?: string;
  type?: string;
  dataPointType?: DataPointType;
  dataPoints?: Array<{ attributes?: Record<string, unknown>; value?: unknown }>;
}

function flattenMetrics(exporter: FakeExporter): FlatMetric[] {
  return (
    exporter.exports as Array<{
      scopeMetrics?: Array<{
        metrics?: Array<{
          descriptor: { name: string; unit?: string; type?: string };
          dataPointType?: DataPointType;
          dataPoints?: FlatMetric['dataPoints'];
        }>;
      }>;
    }>
  ).flatMap(
    (resourceMetrics) =>
      resourceMetrics.scopeMetrics?.flatMap(
        (scope) =>
          scope.metrics?.map((metric) => ({
            name: metric.descriptor.name,
            unit: metric.descriptor.unit,
            type: (metric as { descriptor: { type?: string } }).descriptor.type,
            dataPointType: metric.dataPointType,
            dataPoints: metric.dataPoints,
          })) ?? [],
      ) ?? [],
  );
}

function metricsNamed(exporter: FakeExporter, name: string): FlatMetric[] {
  return flattenMetrics(exporter).filter((metric) => metric.name === name);
}

function createMetrics(exporter: FakeExporter, enabled = true) {
  return createTelemetryMetrics({
    logging: { debug: vi.fn() } as never,
    endpoint: 'http://localhost:4318/v1/metrics',
    exporterFactory: () => exporter,
    dataDirectory: process.cwd(),
    enabled,
    instanceId: '00000000-0000-4000-8000-000000000001',
    exportIntervalMs: 60_000,
    performanceSampleIntervalMs: 5_000,
    filesystemSampleIntervalMs: 60_000,
  });
}

describe('TelemetryMetrics', () => {
  it('samples performance at 5 seconds without exporting until 60 seconds', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);

    await metrics.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exporter.exports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(exporter.exports).toHaveLength(1);
    expect(JSON.stringify(exporter.exports[0])).toContain(
      'klex.process.memory.rss',
    );
    expect(JSON.stringify(exporter.exports[0])).toContain(
      'klex.process.cpu.utilization.distribution',
    );

    await metrics.close();
    await metrics.close();
    expect(exporter.shutdownCount).toBe(1);
    vi.useRealTimers();
  });

  it('resets the CPU baseline before post-opt-in histogram samples', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);

    await metrics.start();
    await metrics.setEnabled(false);
    await metrics.setEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exporter.exports).toHaveLength(1);
    const cpuMetrics = metricsNamed(
      exporter,
      'klex.process.cpu.utilization.distribution',
    );
    expect(cpuMetrics).toHaveLength(1);
    for (const point of cpuMetrics[0]?.dataPoints ?? []) {
      const value = point.value as { sum?: number } | undefined;
      expect(value?.sum ?? 0).toBeLessThanOrEqual(1);
    }

    await metrics.close();
    vi.useRealTimers();
  });

  it('does not start timers or collect while disabled', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter, false);

    await metrics.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exporter.exports).toHaveLength(0);
    await metrics.setEnabled(true);
    await metrics.close();
    vi.useRealTimers();
  });

  it('exports privacy-safe basic model-call dimensions', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    await metrics.setLevel('basic');
    metrics.recordModelCall({
      inputTokens: 10,
      outputTokens: 20,
      inputCacheReadTokens: 30,
      inputCacheWriteTokens: 40,
      operationName: 'generate_content',
      providerName: 'openai',
      source: 'chat',
      errorType: 'raw secret error',
      totalDurationMs: 100,
      ttftMs: 20,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const token = metricsNamed(exporter, 'gen_ai.client.token.usage');
    const duration = metricsNamed(exporter, 'gen_ai.client.operation.duration');
    expect(token.flatMap((metric) => metric.dataPoints ?? [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({
            'gen_ai.operation.name': 'generate_content',
            'gen_ai.provider.name': 'openai',
            'gen_ai.token.type': 'input',
          }),
        }),
      ]),
    );
    expect(duration[0]?.dataPoints?.[0]?.attributes).toEqual(
      expect.objectContaining({ 'klex.outcome': 'success' }),
    );
    const serialized = JSON.stringify(flattenMetrics(exporter));
    expect(serialized).not.toContain('klex.call.source');
    expect(serialized).not.toContain('raw secret error');
    expect(serialized).not.toContain('klex.cache.type');
    await metrics.close();
    vi.useRealTimers();
  });

  it('rejects privacy sentinels from serialized metric export', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    await metrics.setLevel('advanced');
    const sentinels = [
      'RAW_MODEL_ID_SENTINEL',
      'SESSION_ID_SENTINEL',
      'LEASE_ID_SENTINEL',
      'PROVIDER_INSTANCE_ID_SENTINEL',
      'PROMPT_CONTENT_SENTINEL',
      'COMPLETION_CONTENT_SENTINEL',
    ];
    metrics.recordModelCall({
      inputTokens: 1,
      outputTokens: 1,
      inputCacheReadTokens: 1,
      inputCacheWriteTokens: 1,
      operationName: 'generate_content',
      providerName: sentinels[3],
      source: 'chat',
      errorType: 'provider failure',
      totalDurationMs: 1,
      modelId: sentinels[0],
      sessionId: sentinels[1],
      leaseId: sentinels[2],
      prompt: sentinels[4],
      completion: sentinels[5],
    } as unknown as Parameters<typeof metrics.recordModelCall>[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    const serialized = JSON.stringify(exporter.exports);
    for (const sentinel of sentinels)
      expect(serialized).not.toContain(sentinel);
    await metrics.close();
    vi.useRealTimers();
  });

  it('normalizes provider identifiers to semantic-convention values', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    await metrics.setLevel('basic');
    metrics.recordModelCall({
      inputTokens: 1,
      outputTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      providerName: 'Google Vertex AI',
      totalDurationMs: 1,
    });
    metrics.recordModelCall({
      inputTokens: 1,
      outputTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      providerName: 'Azure OpenAI',
      totalDurationMs: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const providers = metricsNamed(exporter, 'gen_ai.client.operation.duration')
      .flatMap((metric) => metric.dataPoints ?? [])
      .map((point) => point.attributes?.['gen_ai.provider.name']);
    expect(providers).toEqual(
      expect.arrayContaining(['gcp.vertex_ai', 'azure.ai.openai']),
    );
    await metrics.close();
    vi.useRealTimers();
  });

  it('exports bounded advanced outcomes, sources, errors, and cache dimensions', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    await metrics.setLevel('advanced');
    for (const usage of [
      { finishReason: 'stop', isError: false, errorType: null },
      {
        finishReason: 'error',
        isError: true,
        errorType: 'provider leaked text',
      },
      { finishReason: 'aborted', isError: true, errorType: 'AbortError' },
    ]) {
      metrics.recordModelCall({
        inputTokens: 1,
        outputTokens: 2,
        inputCacheReadTokens: 3,
        inputCacheWriteTokens: 4,
        operationName: 'generate_content',
        providerName: 'anthropic',
        source: 'extension',
        totalDurationMs: 100,
        ...usage,
      });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    const duration = metricsNamed(exporter, 'gen_ai.client.operation.duration');
    const durationAttributes = duration.flatMap(
      (metric) =>
        metric.dataPoints?.map((point) => point.attributes ?? {}) ?? [],
    );
    expect(durationAttributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 'klex.outcome': 'success' }),
        expect.objectContaining({ 'klex.outcome': 'error' }),
        expect.objectContaining({ 'klex.outcome': 'aborted' }),
        expect.objectContaining({ 'klex.call.source': 'extension' }),
        expect.objectContaining({ 'error.type': 'provider' }),
      ]),
    );
    expect(
      metricsNamed(exporter, 'klex.gen_ai.client.cache.token.usage').flatMap(
        (metric) => metric.dataPoints ?? [],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ 'klex.cache.type': 'read' }),
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({ 'klex.cache.type': 'write' }),
        }),
      ]),
    );
    await metrics.close();
    vi.useRealTimers();
  });

  it('does not retain disabled-period model-call measurements', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    await metrics.setLevel('no');
    metrics.recordModelCall({
      inputTokens: 999,
      outputTokens: 999,
      inputCacheReadTokens: 999,
      inputCacheWriteTokens: 999,
      totalDurationMs: 999,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exporter.exports).toHaveLength(0);
    await metrics.setLevel('basic');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(metricsNamed(exporter, 'gen_ai.client.token.usage')).toHaveLength(0);
    expect(
      metricsNamed(exporter, 'gen_ai.client.operation.duration'),
    ).toHaveLength(0);
    expect(
      metricsNamed(exporter, 'klex.gen_ai.client.cache.token.usage'),
    ).toHaveLength(0);
    await metrics.close();
    vi.useRealTimers();
  });

  it('preserves the instrument contract and awaits level transitions', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);
    await metrics.start();
    const transition = metrics.setLevel('basic');
    expect(transition).toBeInstanceOf(Promise);
    await transition;
    await metrics.setLevel('advanced');
    interactionQueueOverflowed();
    metrics.recordModelCall({
      inputTokens: 1,
      outputTokens: 1,
      inputCacheReadTokens: 1,
      inputCacheWriteTokens: 1,
      totalDurationMs: 1,
      ttftMs: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await metrics.setLevel('no');
    await metrics.setLevel('basic');
    await vi.advanceTimersByTimeAsync(60_000);
    const expected = new Map([
      ['gen_ai.client.operation.duration', 's'],
      ['gen_ai.client.token.usage', '{token}'],
      ['gen_ai.client.operation.time_to_first_chunk', 's'],
      ['klex.gen_ai.client.cache.token.usage', '{token}'],
      ['process.uptime', 's'],
      ['klex.interaction.lease.active', '{lease}'],
      ['klex.interaction.queue.depth', '{update}'],
      ['klex.interaction.queue.overflow', '{event}'],
      ['klex.realtime.session.active', '{session}'],
      ['klex.process.memory.rss', 'By'],
      ['klex.process.cpu.utilization.distribution', '1'],
    ]);
    for (const [name, unit] of expected) {
      expect(metricsNamed(exporter, name)[0]?.unit, name).toBe(unit);
    }
    const expectedTypes = new Map([
      ['gen_ai.client.operation.duration', DataPointType.HISTOGRAM],
      ['gen_ai.client.token.usage', DataPointType.HISTOGRAM],
      ['gen_ai.client.operation.time_to_first_chunk', DataPointType.HISTOGRAM],
      ['klex.gen_ai.client.cache.token.usage', DataPointType.HISTOGRAM],
      ['process.uptime', DataPointType.GAUGE],
      ['klex.interaction.lease.active', DataPointType.GAUGE],
      ['klex.interaction.queue.depth', DataPointType.GAUGE],
      ['klex.interaction.queue.overflow', DataPointType.SUM],
      ['klex.realtime.session.active', DataPointType.GAUGE],
      ['klex.process.memory.rss', DataPointType.HISTOGRAM],
      ['klex.process.cpu.utilization.distribution', DataPointType.HISTOGRAM],
    ]);
    for (const [name, type] of expectedTypes) {
      expect(metricsNamed(exporter, name)[0]?.dataPointType, name).toBe(type);
    }
    await metrics.close();
    vi.useRealTimers();
  });

  it('exports advanced per-session and tool telemetry without content', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);

    metrics.registerSession({
      id: 'session-1',
      name: 'primary',
      active: true,
      runtimeState: 'working',
      historyLength: 12,
      transformedHistoryLength: 8,
    });
    await metrics.start();
    await metrics.setLevel('advanced');
    metrics.recordToolCall('session-1', 'search', true);
    await vi.advanceTimersByTimeAsync(60_000);

    const payload = JSON.stringify(exporter.exports);
    expect(payload).toContain('klex.session.active');
    expect(payload).toContain('klex.session.history.length');
    expect(payload).toContain('klex.session.history.transformed_length');
    expect(payload).toContain('klex.session.tool.calls');
    expect(payload).toContain('session-1');
    expect(payload).toContain('primary');
    expect(payload).toContain('search');
    expect(payload).not.toContain('secret-content');

    await metrics.close();
    vi.useRealTimers();
  });

  it('does not add timers when enabling repeatedly', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter, false);

    await metrics.setEnabled(true);
    await metrics.setEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exporter.exports).toHaveLength(1);

    await metrics.close();
    vi.useRealTimers();
  });
});
