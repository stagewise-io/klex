import { readdir, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import {
  type Attributes,
  type Counter,
  type Histogram,
  metrics,
  type ObservableGauge,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { resources } from '@opentelemetry/sdk-node';

import type { ModuleLogger } from '@stagewise/logger';

import {
  getInteractionTelemetry,
  getRealtimeSessionCount,
  setQueueOverflowRecorder,
  setTelemetryActivityEnabled,
} from './activity';

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const DEFAULT_PERFORMANCE_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_FILESYSTEM_SAMPLE_INTERVAL_MS = 60_000;
const TOKEN_BUCKET_BOUNDARIES = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];
const DURATION_BUCKET_BOUNDARIES = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];
const TELEMETRY_LEVELS = ['no', 'basic', 'advanced', 'debug'] as const;
export type MetricsTelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetryMetricsDependencies {
  logging: ModuleLogger;
  endpoint: string;
  headers?: Record<string, string>;
  exporterFactory?: () => PushMetricExporter;
  dataDirectory: string;
  enabled: boolean;
  instanceId: string;
  serviceVersion?: string;
  exportIntervalMs?: number;
  performanceSampleIntervalMs?: number;
  filesystemSampleIntervalMs?: number;
}

export interface TelemetryMetrics {
  start(): Promise<void>;
  close(): Promise<void>;
  recordModelCall(usage: ModelCallUsage): void;
  registerSession(session: SessionTelemetryState): void;
  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void;
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
  setEnabled(enabled: boolean): Promise<void>;
  setLevel(level: MetricsTelemetryLevel): Promise<void>;
}

export interface SessionTelemetryState {
  id: string;
  name: string;
  active: boolean;
  runtimeState: string;
  historyLength: number;
  transformedHistoryLength: number;
}

export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  operationName?: string;
  providerName?: string;
  source?: 'chat' | 'extension';
  finishReason?: string;
  isError?: boolean;
  errorType?: string | null;
  totalDurationMs?: number | null;
  ttftMs?: number | null;
}

class GatedMetricExporter implements PushMetricExporter {
  private enabled = true;

  constructor(private readonly delegate: PushMetricExporter) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  export(
    metricData: Parameters<PushMetricExporter['export']>[0],
    resultCallback: Parameters<PushMetricExporter['export']>[1],
  ): void {
    if (!this.enabled) {
      resultCallback({ code: 0 });
      return;
    }
    this.delegate.export(metricData, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

class TelemetryMetricsModule implements TelemetryMetrics {
  private provider: MeterProvider | null = null;
  private globalProviderRegistered = false;
  private gatedExporter: GatedMetricExporter | null = null;
  private performanceTimer: NodeJS.Timeout | null = null;
  private filesystemTimer: NodeJS.Timeout | null = null;
  private started = false;
  private enabled: boolean;
  private lastCpu = process.cpuUsage();
  private lastSampleAt = process.hrtime.bigint();
  private latestMemoryRssBytes = 0;
  private latestCpuUserUtilization = 0;
  private latestCpuSystemUtilization = 0;
  private dataDirectoryBytes = 0;
  private tokens: Histogram | null = null;
  private ttft: Histogram | null = null;
  private duration: Histogram | null = null;
  private cacheTokens: Histogram | null = null;
  private level: MetricsTelemetryLevel = 'no';
  private memorySamples: Histogram | null = null;
  private cpuSamples: Histogram | null = null;
  private sessionActive: ObservableGauge | null = null;
  private sessionRuntimeState: ObservableGauge | null = null;
  private sessionHistoryLength: ObservableGauge | null = null;
  private sessionTransformedHistoryLength: ObservableGauge | null = null;
  private toolCalls: Counter | null = null;
  private readonly sessions = new Map<string, SessionTelemetryState>();
  // Node does not expose portable per-process network byte counters. We do not
  // substitute system-wide counters because that would misattribute traffic.

  constructor(private readonly deps: TelemetryMetricsDependencies) {
    this.enabled = deps.enabled;
  }

  async start(): Promise<void> {
    if (this.started || !this.enabled) return;
    this.started = true;
    setTelemetryActivityEnabled(true);

    const exportIntervalMs =
      this.deps.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS;
    const performanceSampleIntervalMs =
      this.deps.performanceSampleIntervalMs ??
      DEFAULT_PERFORMANCE_SAMPLE_INTERVAL_MS;
    const filesystemSampleIntervalMs =
      this.deps.filesystemSampleIntervalMs ??
      DEFAULT_FILESYSTEM_SAMPLE_INTERVAL_MS;
    const exporter = new GatedMetricExporter(
      this.deps.exporterFactory?.() ??
        new OTLPMetricExporter({
          url: this.deps.endpoint,
          headers: this.deps.headers,
        }),
    );
    this.gatedExporter = exporter;
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: exportIntervalMs,
      exportTimeoutMillis: Math.min(exportIntervalMs, 10_000),
    });
    const provider = new MeterProvider({
      resource: resources.resourceFromAttributes({
        'service.name': 'klex',
        'service.namespace': 'stagewise',
        ...(this.deps.serviceVersion
          ? { 'service.version': this.deps.serviceVersion }
          : {}),
        'service.instance.id': this.deps.instanceId,
      }),
      readers: [reader],
      views: [
        {
          instrumentName: 'gen_ai.client.token.usage',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: TOKEN_BUCKET_BOUNDARIES,
            },
          },
        },
        {
          instrumentName: 'gen_ai.client.operation.time_to_first_chunk',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [
                0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12,
                10.24, 20.48, 40.96, 81.92,
              ],
            },
          },
        },
        {
          instrumentName: 'gen_ai.client.operation.duration',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: DURATION_BUCKET_BOUNDARIES },
          },
        },
        {
          instrumentName: 'klex.gen_ai.client.cache.token.usage',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: TOKEN_BUCKET_BOUNDARIES },
          },
        },
        {
          instrumentName: 'klex.process.memory.rss',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [
                64 * 1024 ** 2,
                128 * 1024 ** 2,
                256 * 1024 ** 2,
                512 * 1024 ** 2,
                1024 ** 3,
                2 * 1024 ** 3,
                4 * 1024 ** 3,
              ],
            },
          },
        },
        {
          instrumentName: 'klex.process.cpu.utilization.distribution',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1],
            },
          },
        },
      ],
    });
    this.provider = provider;
    if (!this.globalProviderRegistered) {
      metrics.setGlobalMeterProvider(provider);
      this.globalProviderRegistered = true;
    }

    const meter = provider.getMeter('klex.resources');
    meter
      .createObservableUpDownCounter('process.memory.usage', {
        description: 'Resident memory used by the Klex process',
        unit: 'By',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(this.latestMemoryRssBytes);
      });
    meter
      .createObservableGauge('process.cpu.utilization', {
        description:
          'CPU utilization of the Klex process since the previous sample',
        unit: '1',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(this.latestCpuUserUtilization, {
          'cpu.mode': 'user',
        });
        observable.observe(this.latestCpuSystemUtilization, {
          'cpu.mode': 'system',
        });
      });
    this.tokens = meter.createHistogram('gen_ai.client.token.usage', {
      description: 'Input and output tokens used by model calls',
      unit: '{token}',
    });
    this.ttft = meter.createHistogram(
      'gen_ai.client.operation.time_to_first_chunk',
      {
        description: 'Time from client operation start to first response chunk',
        unit: 's',
      },
    );
    this.duration = meter.createHistogram('gen_ai.client.operation.duration', {
      description: 'Duration of completed model operations',
      unit: 's',
    });
    this.cacheTokens = meter.createHistogram(
      'klex.gen_ai.client.cache.token.usage',
      {
        description: 'Prompt cache token usage',
        unit: '{token}',
      },
    );
    meter
      .createObservableGauge('process.uptime', {
        description: 'Time the Klex process has been running',
        unit: 's',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(process.uptime());
      });
    this.memorySamples = meter.createHistogram('klex.process.memory.rss', {
      description: 'Distribution of Klex process RSS samples',
      unit: 'By',
    });
    this.cpuSamples = meter.createHistogram(
      'klex.process.cpu.utilization.distribution',
      {
        description: 'Distribution of Klex process CPU utilization samples',
        unit: '1',
      },
    );
    meter
      .createObservableGauge('klex.interaction.lease.active', {
        description: 'Currently active interaction leases',
        unit: '{lease}',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(getInteractionTelemetry().activeLeases);
      });
    meter
      .createObservableGauge('klex.interaction.queue.depth', {
        description: 'Buffered interaction updates',
        unit: '{update}',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(getInteractionTelemetry().queuedUpdates);
      });
    const queueOverflow = meter.createCounter(
      'klex.interaction.queue.overflow',
      {
        description: 'Interaction queue overflow events',
        unit: '{event}',
      },
    );
    setQueueOverflowRecorder(() => queueOverflow.add(1));
    meter
      .createObservableGauge('klex.realtime.session.active', {
        description: 'Active realtime sessions',
        unit: '{session}',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(getRealtimeSessionCount());
      });
    this.sessionActive = meter.createObservableGauge('klex.session.active', {
      description: 'Whether each known session is active',
      unit: '1',
    });
    this.sessionActive.addCallback((observable) => {
      if (!this.started || !this.enabled || this.level !== 'advanced') return;
      for (const session of this.sessions.values()) {
        observable.observe(session.active ? 1 : 0, sessionAttributes(session));
      }
    });
    this.sessionRuntimeState = meter.createObservableGauge(
      'klex.session.runtime_state',
      { description: 'Runtime state of each known session', unit: '1' },
    );
    this.sessionRuntimeState.addCallback((observable) => {
      if (!this.started || !this.enabled || this.level !== 'advanced') return;
      for (const session of this.sessions.values()) {
        observable.observe(1, {
          ...sessionAttributes(session),
          'klex.session.runtime.state': session.runtimeState,
        });
      }
    });
    this.sessionHistoryLength = meter.createObservableGauge(
      'klex.session.history.length',
      {
        description: 'Full message history length of each session',
        unit: '{message}',
      },
    );
    this.sessionHistoryLength.addCallback((observable) => {
      if (!this.started || !this.enabled || this.level !== 'advanced') return;
      for (const session of this.sessions.values()) {
        observable.observe(session.historyLength, sessionAttributes(session));
      }
    });
    this.sessionTransformedHistoryLength = meter.createObservableGauge(
      'klex.session.history.transformed_length',
      {
        description: 'Message history length after transformation',
        unit: '{message}',
      },
    );
    this.sessionTransformedHistoryLength.addCallback((observable) => {
      if (!this.started || !this.enabled || this.level !== 'advanced') return;
      for (const session of this.sessions.values()) {
        observable.observe(
          session.transformedHistoryLength,
          sessionAttributes(session),
        );
      }
    });
    this.toolCalls = meter.createCounter('klex.session.tool.calls', {
      description: 'Tool calls made by each session',
      unit: '{call}',
    });

    meter
      .createObservableGauge('klex.data_directory.size', {
        description: 'Data-directory filesystem allocation in bytes',
        unit: 'By',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(this.dataDirectoryBytes);
      });

    this.resetCpuBaseline();
    this.sampleMemory();
    this.performanceTimer = setInterval(() => {
      this.sampleCpu();
      this.sampleMemory();
    }, performanceSampleIntervalMs);
    this.performanceTimer.unref();
    this.filesystemTimer = setInterval(
      () => void this.sampleDataDirectory(),
      filesystemSampleIntervalMs,
    );
    this.filesystemTimer.unref();
    void this.sampleDataDirectory();
  }

  recordModelCall(usage: ModelCallUsage): void {
    if (!this.started || !this.enabled) return;
    const advanced = this.level === 'advanced' || this.level === 'debug';
    const dimensions = {
      'gen_ai.operation.name': usage.operationName ?? 'generate_content',
      'gen_ai.provider.name': normalizeProviderName(
        usage.providerName ?? 'unknown',
      ),
    };
    if (usage.inputTokens > 0) {
      this.tokens?.record(usage.inputTokens, {
        ...dimensions,
        'gen_ai.token.type': 'input',
      });
    }
    if (usage.outputTokens > 0) {
      this.tokens?.record(usage.outputTokens, {
        ...dimensions,
        'gen_ai.token.type': 'output',
      });
    }
    if (usage.ttftMs !== undefined && usage.ttftMs !== null) {
      this.ttft?.record(usage.ttftMs / 1_000, dimensions);
    }
    if (usage.totalDurationMs !== undefined && usage.totalDurationMs !== null) {
      const outcome = usage.isError
        ? usage.finishReason === 'aborted' || usage.finishReason === 'abort'
          ? 'aborted'
          : 'error'
        : 'success';
      this.duration?.record(usage.totalDurationMs / 1_000, {
        ...dimensions,
        'klex.outcome': outcome,
        ...(advanced && usage.source
          ? { 'klex.call.source': usage.source }
          : {}),
        ...(advanced && usage.errorType
          ? { 'error.type': normalizeErrorType(usage.errorType) }
          : {}),
      });
    }
    if (advanced) {
      if (usage.inputCacheReadTokens > 0)
        this.cacheTokens?.record(usage.inputCacheReadTokens, {
          ...dimensions,
          'klex.cache.type': 'read',
        });
      if (usage.inputCacheWriteTokens > 0)
        this.cacheTokens?.record(usage.inputCacheWriteTokens, {
          ...dimensions,
          'klex.cache.type': 'write',
        });
    }
  }

  registerSession(session: SessionTelemetryState): void {
    this.sessions.set(session.id, { ...session });
  }

  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    Object.assign(current, update);
  }

  recordToolCall(sessionId: string, toolName: string, success: boolean): void {
    if (!this.started || !this.enabled || this.level !== 'advanced') return;
    const session = this.sessions.get(sessionId);
    this.toolCalls?.add(1, {
      ...(session
        ? sessionAttributes(session)
        : { 'klex.session.id': sessionId }),
      'klex.tool.name': toolName,
      'klex.tool.outcome': success ? 'success' : 'error',
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled && (enabled === false || this.started)) return;
    this.enabled = enabled;
    this.level = enabled ? (this.level === 'no' ? 'basic' : this.level) : 'no';
    if (!enabled) {
      await this.close();
      return;
    }
    setTelemetryActivityEnabled(true);
    if (this.started) {
      this.resetCpuBaseline();
      this.sampleMemory();
    } else {
      await this.start();
    }
  }

  async close(): Promise<void> {
    this.started = false;
    this.enabled = false;
    this.level = 'no';
    setTelemetryActivityEnabled(false);
    this.gatedExporter?.setEnabled(false);
    setQueueOverflowRecorder(null);
    if (this.performanceTimer) clearInterval(this.performanceTimer);
    if (this.filesystemTimer) clearInterval(this.filesystemTimer);
    this.performanceTimer = null;
    this.filesystemTimer = null;
    if (this.provider) await this.provider.shutdown();
    this.provider = null;
    this.gatedExporter = null;
    this.tokens = null;
    this.ttft = null;
    this.memorySamples = null;
    this.cpuSamples = null;
  }

  async setLevel(level: MetricsTelemetryLevel): Promise<void> {
    if (this.level === level && this.enabled === (level !== 'no')) return;
    this.level = level;
    await this.setEnabled(level !== 'no');
  }

  private resetCpuBaseline(): void {
    this.lastCpu = process.cpuUsage();
    this.lastSampleAt = process.hrtime.bigint();
  }

  private sampleCpu(): void {
    if (!this.started || !this.enabled) return;
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMicros = Number(now - this.lastSampleAt) / 1_000;
    this.lastCpu = process.cpuUsage();
    this.lastSampleAt = now;
    if (elapsedMicros <= 0) return;
    const processorCount = availableParallelism();
    this.latestCpuUserUtilization = cpu.user / elapsedMicros / processorCount;
    this.latestCpuSystemUtilization =
      cpu.system / elapsedMicros / processorCount;
    this.cpuSamples?.record(this.latestCpuUserUtilization, {
      'cpu.mode': 'user',
    });
    this.cpuSamples?.record(this.latestCpuSystemUtilization, {
      'cpu.mode': 'system',
    });
  }

  private sampleMemory(): void {
    if (!this.started || !this.enabled) return;
    this.latestMemoryRssBytes = process.memoryUsage().rss;
    this.memorySamples?.record(this.latestMemoryRssBytes);
  }

  private async sampleDataDirectory(): Promise<void> {
    if (!this.started || !this.enabled) return;
    try {
      const dataDirectoryBytes = await directorySize(this.deps.dataDirectory);
      if (!this.started || !this.enabled) return;
      this.dataDirectoryBytes = dataDirectoryBytes;
    } catch (error) {
      this.deps.logging.debug(
        { error },
        'Unable to sample data-directory size',
      );
    }
  }
}

function sessionAttributes(session: SessionTelemetryState): Attributes {
  return {
    'klex.session.id': session.id,
    'klex.session.name': session.name,
  };
}

function normalizeProviderName(provider: string): string {
  const normalized = provider.toLowerCase().replace(/[\s_.-]+/g, '');
  if (normalized.startsWith('googlevertex')) return 'gcp.vertex_ai';
  if (normalized.startsWith('googlegenerativeai') || normalized === 'google')
    return 'gcp.gemini';
  if (
    normalized.startsWith('amazonbedrock') ||
    normalized.startsWith('bedrock')
  )
    return 'aws.bedrock';
  if (normalized.startsWith('azureopenai')) return 'azure.ai.openai';
  if (normalized.startsWith('azure')) return 'azure.ai.inference';
  if (normalized.startsWith('anthropic')) return 'anthropic';
  if (normalized.startsWith('openai')) return 'openai';
  if (normalized.startsWith('mistral')) return 'mistral_ai';
  if (normalized.startsWith('cohere')) return 'cohere';
  if (normalized.startsWith('groq')) return 'groq';
  if (normalized.startsWith('deepseek')) return 'deepseek';
  if (normalized.startsWith('perplexity')) return 'perplexity';
  if (normalized.startsWith('xai')) return 'x_ai';
  if (normalized.startsWith('openrouter')) return 'openrouter';
  if (normalized.startsWith('together')) return 'together';
  if (normalized.startsWith('fireworks')) return 'fireworks';
  if (normalized.startsWith('ollama')) return 'ollama';
  if (normalized.startsWith('lmstudio')) return 'lmstudio';
  return 'unknown';
}

function normalizeErrorType(
  errorType: string,
):
  | 'timeout'
  | 'rate_limit'
  | 'authentication'
  | 'provider'
  | 'aborted'
  | '_OTHER' {
  const normalized = errorType.toLowerCase();
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('rate') && normalized.includes('limit'))
    return 'rate_limit';
  if (
    normalized.includes('auth') ||
    normalized.includes('credential') ||
    normalized.includes('unauthorized')
  )
    return 'authentication';
  if (normalized.includes('abort')) return 'aborted';
  if (normalized.includes('provider')) return 'provider';
  return '_OTHER';
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

export function createTelemetryMetrics(
  deps: TelemetryMetricsDependencies,
): TelemetryMetrics {
  return new TelemetryMetricsModule(deps);
}
