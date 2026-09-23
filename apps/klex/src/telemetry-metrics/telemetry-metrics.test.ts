import { metrics as metricApi } from '@opentelemetry/api';
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
  exportFailure: Error | undefined;

  export(
    metrics: Parameters<PushMetricExporter['export']>[0],
    callback: Parameters<PushMetricExporter['export']>[1],
  ): void {
    this.exports.push(metrics);
    callback(
      this.exportFailure ? { code: 1, error: this.exportFailure } : { code: 0 },
    );
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
    resourceAttributes: {
      'service.name': 'klex',
      'service.namespace': 'stagewise',
      'service.instance.id': '00000000-0000-4000-8000-000000000001',
      'host.arch': 'arm64',
      'os.type': 'darwin',
      'os.version': 'test',
    },
    exportIntervalMs: 60_000,
    performanceSampleIntervalMs: 5_000,
    filesystemSampleIntervalMs: 60_000,
  });
}

describe('TelemetryMetrics', () => {
  it('keeps the global meter usable across disable and re-enable', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const telemetryMetrics = createMetrics(exporter, false);

    await telemetryMetrics.start();
    const counter = metricApi
      .getMeter('telemetry-lifecycle-regression')
      .createCounter('klex.test.lifecycle');
    await telemetryMetrics.setLevel('basic');
    counter.add(1);
    await telemetryMetrics.setLevel('no');
    await telemetryMetrics.setLevel('advanced');
    counter.add(2);
    await vi.advanceTimersByTimeAsync(60_000);

    const points = metricsNamed(exporter, 'klex.test.lifecycle').flatMap(
      (metric) => metric.dataPoints ?? [],
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(3);
    await telemetryMetrics.close();
    vi.useRealTimers();
  });

  it('keeps one provider through the complete level state machine', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    let exporterCreations = 0;
    const telemetryMetrics = createTelemetryMetrics({
      logging: { debug: vi.fn() } as never,
      endpoint: 'http://localhost:4318/v1/metrics',
      exporterFactory: () => {
        exporterCreations += 1;
        return exporter;
      },
      dataDirectory: process.cwd(),
      enabled: false,
      instanceId: '00000000-0000-4000-8000-000000000001',
    });

    await telemetryMetrics.start();
    await telemetryMetrics.setLevel('basic');
    await telemetryMetrics.setLevel('advanced');
    await telemetryMetrics.setLevel('no');
    await telemetryMetrics.setLevel('debug');
    await telemetryMetrics.close();
    await telemetryMetrics.close();

    expect(exporterCreations).toBe(1);
    expect(exporter.shutdownCount).toBe(1);
    vi.useRealTimers();
  });

  it('keeps the disabled state coherent when provider startup fails', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    let fail = true;
    const telemetryMetrics = createTelemetryMetrics({
      logging: { debug: vi.fn() } as never,
      endpoint: 'http://localhost:4318/v1/metrics',
      exporterFactory: () => {
        if (fail) throw new Error('exporter construction failed');
        return exporter;
      },
      dataDirectory: process.cwd(),
      enabled: false,
      instanceId: '00000000-0000-4000-8000-000000000001',
    });
    await expect(telemetryMetrics.start()).rejects.toThrow(
      'exporter construction failed',
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exporter.exports).toHaveLength(0);

    fail = false;
    await telemetryMetrics.start();
    await telemetryMetrics.setLevel('basic');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exporter.exports).toHaveLength(2);
    await telemetryMetrics.close();
    expect(exporter.exports).toHaveLength(4);
    vi.useRealTimers();
  });

  it('serializes rapid transitions with the latest level winning', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const telemetryMetrics = createMetrics(exporter, false);
    await telemetryMetrics.start();

    await Promise.all([
      telemetryMetrics.setLevel('basic'),
      telemetryMetrics.setLevel('no'),
      telemetryMetrics.setLevel('advanced'),
    ]);
    telemetryMetrics.recordModelCall({
      inputTokens: 1,
      outputTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      totalDurationMs: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      metricsNamed(exporter, 'gen_ai.client.inference.usage.input_tokens'),
    ).toHaveLength(1);
    await telemetryMetrics.close();
    vi.useRealTimers();
  });

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

  it('collects and exports a final metric batch during shutdown', async () => {
    vi.useFakeTimers();
    const exporter = new FakeExporter();
    const metrics = createMetrics(exporter);

    await metrics.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exporter.exports).toHaveLength(0);

    await metrics.close();

    expect(exporter.exports).toHaveLength(2);
    expect(JSON.stringify(exporter.exports.at(-1))).toContain(
      'klex.process.memory.rss',
    );
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
    const usageDimensions = {
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'openai',
      'gen_ai.token.modality': 'unknown',
    };
    for (const [name, value] of [
      ['gen_ai.client.inference.usage.input_tokens', 10],
      ['gen_ai.client.inference.usage.output_tokens', 20],
      ['gen_ai.client.inference.usage.cache_read.input_tokens', 30],
      ['gen_ai.client.inference.usage.cache_write.input_tokens', 40],
    ] as const) {
      expect(metricsNamed(exporter, name)[0]?.dataPoints, name).toEqual([
        expect.objectContaining({ attributes: usageDimensions, value }),
      ]);
    }
    expect(
      metricsNamed(
        exporter,
        'gen_ai.client.inference.operation.input_tokens',
      )[0]?.dataPoints?.[0]?.attributes,
    ).toEqual({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'openai',
    });
    const duration = metricsNamed(exporter, 'gen_ai.client.operation.duration');
    expect(duration[0]?.dataPoints?.[0]?.attributes).toEqual(
      expect.objectContaining({ 'klex.outcome': 'success' }),
    );
    expect(duration[0]?.dataPoints?.[0]?.attributes).not.toHaveProperty(
      'error.type',
    );
    const serialized = JSON.stringify(flattenMetrics(exporter));
    expect(serialized).not.toContain('klex.call.source');
    expect(serialized).not.toContain('raw secret error');
    expect(serialized).not.toContain('klex.cache.type');
    expect(serialized).not.toContain('gen_ai.client.token.usage');
    expect(serialized).not.toContain('gen_ai.token.type');
    expect(serialized).not.toContain('klex.host.logical_processor.count');
    expect(serialized).not.toContain('klex.host.memory.capacity');
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
    for (const [name, value] of [
      ['gen_ai.client.inference.usage.input_tokens', 3],
      ['gen_ai.client.inference.usage.output_tokens', 6],
      ['gen_ai.client.inference.usage.cache_read.input_tokens', 9],
      ['gen_ai.client.inference.usage.cache_write.input_tokens', 12],
    ] as const) {
      expect(
        metricsNamed(exporter, name)[0]?.dataPoints?.[0]?.value,
        name,
      ).toBe(value);
    }
    // Only the successful call contributes to per-operation distributions.
    expect(
      metricsNamed(
        exporter,
        'gen_ai.client.inference.operation.input_tokens',
      )[0]?.dataPoints?.[0]?.value,
    ).toEqual(expect.objectContaining({ count: 1, sum: 1 }));
    expect(durationAttributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'klex.outcome': 'aborted',
          'error.type': 'aborted',
        }),
      ]),
    );
    expect(
      metricsNamed(exporter, 'gen_ai.client.operation.errors'),
    ).toHaveLength(0);
    const exportedResource = (
      exporter.exports[0] as {
        resource?: { attributes?: Record<string, unknown> };
      }
    ).resource;
    expect(exportedResource?.attributes).toEqual(
      expect.objectContaining({
        'host.arch': expect.any(String),
        'os.type': expect.any(String),
        'os.version': expect.any(String),
      }),
    );
    expect(
      metricsNamed(exporter, 'klex.host.logical_processor.count')[0]
        ?.dataPoints?.[0]?.attributes,
    ).toEqual({});
    expect(
      metricsNamed(exporter, 'klex.host.memory.capacity')[0]?.dataPoints,
    ).toHaveLength(2);
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
    expect(
      metricsNamed(exporter, 'gen_ai.client.inference.usage.input_tokens'),
    ).toHaveLength(0);
    expect(
      metricsNamed(exporter, 'gen_ai.client.inference.operation.input_tokens'),
    ).toHaveLength(0);
    expect(
      metricsNamed(exporter, 'gen_ai.client.operation.duration'),
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
      ['gen_ai.client.inference.usage.input_tokens', '{token}'],
      ['gen_ai.client.inference.usage.output_tokens', '{token}'],
      ['gen_ai.client.inference.usage.cache_read.input_tokens', '{token}'],
      ['gen_ai.client.inference.usage.cache_write.input_tokens', '{token}'],
      ['gen_ai.client.inference.operation.input_tokens', '{token}'],
      ['gen_ai.client.inference.operation.output_tokens', '{token}'],
      ['gen_ai.client.operation.time_to_first_chunk', 's'],
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
      ['gen_ai.client.inference.usage.input_tokens', DataPointType.SUM],
      ['gen_ai.client.inference.usage.output_tokens', DataPointType.SUM],
      [
        'gen_ai.client.inference.usage.cache_read.input_tokens',
        DataPointType.SUM,
      ],
      [
        'gen_ai.client.inference.usage.cache_write.input_tokens',
        DataPointType.SUM,
      ],
      [
        'gen_ai.client.inference.operation.input_tokens',
        DataPointType.HISTOGRAM,
      ],
      [
        'gen_ai.client.inference.operation.output_tokens',
        DataPointType.HISTOGRAM,
      ],
      ['gen_ai.client.operation.time_to_first_chunk', DataPointType.HISTOGRAM],
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

  it.each(['advanced', 'debug'] as const)(
    'exports %s per-session state and last-call telemetry',
    async (level) => {
      vi.useFakeTimers();
      const exporter = new FakeExporter();
      const metrics = createMetrics(exporter);

      metrics.registerSession({
        id: 'session-1',
        name: 'primary',
        kind: 'child',
        extensionIdentifier: 'memory',
        parentId: 'main-session',
        active: true,
        runtimeState: 'working',
        historyLength: 12,
        transformedHistoryLength: 8,
      });
      metrics.registerSession({
        id: 'session-2',
        name: 'secondary',
        kind: 'child',
        extensionIdentifier: 'memory',
        parentId: 'main-session',
        active: true,
        runtimeState: 'idle',
        historyLength: 3,
        transformedHistoryLength: 2,
      });
      await metrics.start();
      await metrics.setLevel(level);
      metrics.recordModelCall({
        sessionId: 'session-1',
        inputTokens: 100,
        outputTokens: 20,
        inputCacheReadTokens: 60,
        inputCacheWriteTokens: 10,
        source: 'extension',
        totalDurationMs: 100,
      });
      metrics.recordToolCall('session-1', 'search', true, 25);
      metrics.recordToolCall('session-1', 'search', false, 50, 'timeout');
      metrics.recordToolCall(
        'session-1',
        'search',
        false,
        50,
        'unexpected raw error',
      );
      await vi.advanceTimersByTimeAsync(60_000);

      const payload = JSON.stringify(exporter.exports);
      expect(payload).toContain('klex.session.active');
      expect(payload).toContain('klex.session.history.length');
      expect(payload).toContain('klex.session.history.transformed_length');
      expect(payload).toContain('klex.session.last_call.tokens');
      expect(payload).not.toContain('klex.session.last_call.input_tokens');
      expect(payload).not.toContain('klex.session.last_call.cache_read_tokens');
      expect(payload).not.toContain(
        'klex.session.last_call.cache_write_tokens',
      );
      expect(payload).toContain('klex.session.last_call.cache_read_ratio');
      expect(payload).toContain('gen_ai.execute_tool.duration');
      expect(payload).not.toContain('klex.session.tool.');
      expect(payload).not.toContain('unexpected raw error');
      expect(payload).toContain('session-1');
      expect(payload).toContain('session-2');
      expect(payload).toContain('main-session');
      expect(payload).toContain('primary');
      expect(payload).toContain('memory');
      expect(payload).toContain('search');
      expect(payload).not.toContain('secret-content');

      const activePoints = metricsNamed(
        exporter,
        'klex.session.active',
      ).flatMap((metric) => metric.dataPoints ?? []);
      expect(activePoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: 1,
            attributes: expect.objectContaining({
              'klex.session.id': 'session-1',
            }),
          }),
          expect.objectContaining({
            value: 0,
            attributes: expect.objectContaining({
              'klex.session.id': 'session-2',
            }),
          }),
        ]),
      );

      const toolPoints = metricsNamed(
        exporter,
        'gen_ai.execute_tool.duration',
      ).flatMap((metric) => metric.dataPoints ?? []);
      expect(toolPoints.map((point) => point.attributes)).toEqual(
        expect.arrayContaining([
          {
            'klex.session.name': 'primary',
            'klex.session.kind': 'child',
            'klex.session.extension': 'memory',
            'gen_ai.tool.name': 'search',
            'gen_ai.tool.type': 'function',
          },
          expect.objectContaining({ 'error.type': 'timeout' }),
          expect.objectContaining({ 'error.type': '_OTHER' }),
        ]),
      );
      // Unbounded session ids stay on the pruned gauges only.
      for (const point of toolPoints) {
        expect(point.attributes).not.toHaveProperty('klex.session.id');
        expect(point.attributes).not.toHaveProperty('klex.session.parent.id');
      }

      const lastCallPoints = metricsNamed(
        exporter,
        'klex.session.last_call.tokens',
      ).flatMap((metric) => metric.dataPoints ?? []);
      expect(
        lastCallPoints.map((point) => [
          point.attributes?.['klex.token.type'],
          point.value,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['input', 100],
          ['cache_read', 60],
          ['cache_write', 10],
        ]),
      );
      const inputPoint = lastCallPoints.find(
        (point) => point.attributes?.['klex.token.type'] === 'input',
      );
      expect(inputPoint).toEqual(
        expect.objectContaining({
          value: 100,
          attributes: expect.objectContaining({
            'klex.session.id': 'session-1',
            'klex.session.name': 'primary',
            'klex.session.kind': 'child',
            'klex.session.extension': 'memory',
            'klex.session.parent.id': 'main-session',
            'klex.call.source': 'extension',
          }),
        }),
      );
      expect(
        metricsNamed(
          exporter,
          'klex.session.last_call.cache_read_ratio',
        ).flatMap((metric) => metric.dataPoints ?? [])[0]?.value,
      ).toBe(0.6);

      metrics.unregisterSession('session-1');
      const retainedSession = (
        metrics as unknown as {
          sessions: Map<string, { active: boolean; runtimeState: string }>;
        }
      ).sessions.get('session-1');
      expect(retainedSession).toMatchObject({
        active: false,
        runtimeState: 'terminated',
      });

      await metrics.close();
      vi.useRealTimers();
    },
  );

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

  it('fails open when the telemetry endpoint is unavailable', async () => {
    const exporter = new FakeExporter();
    exporter.exportFailure = new Error('collector unavailable');
    const telemetryMetrics = createMetrics(exporter, false);

    await telemetryMetrics.start();
    await telemetryMetrics.setLevel('basic');
    await expect(telemetryMetrics.forceFlush()).resolves.toBeUndefined();
    await expect(telemetryMetrics.close()).resolves.toBeUndefined();
  });
});
