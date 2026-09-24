import { readdir, stat } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import {
  type Attributes,
  type Counter,
  context,
  type Histogram,
  metrics,
  type ObservableGauge,
  type UpDownCounter,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  AggregationType,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import type { ModuleLogger } from '@stagewise/logger';

import type { TelemetryPolicy } from '@/telemetry-policy';
import { createTelemetryResourceFromAttributes } from '@/telemetry-resource';

import {
  getInteractionTelemetry,
  getRealtimeSessionCount,
  setQueueOverflowRecorder,
  setTelemetryActivityEnabled,
} from './activity';

// OpenTelemetry's common default is 60 seconds. Klex uses 30 seconds to
// reduce short-process loss while keeping export overhead bounded.
const DEFAULT_EXPORT_INTERVAL_MS = 30_000;
const DEFAULT_PERFORMANCE_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_FILESYSTEM_SAMPLE_INTERVAL_MS = 60_000;
const TERMINAL_SESSION_RETENTION_MS = 60 * 60 * 1_000;
const MAX_METRIC_TOOL_NAMES = 256;
const MAX_METRIC_ATTRIBUTE_LENGTH = 128;
const TOKEN_BUCKET_BOUNDARIES = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];
const DURATION_BUCKET_BOUNDARIES = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];
/**
 * `klex.token.type` values of the per-session last-call gauge. Cache types are
 * subsets of `input`, so aggregating across every type double-counts cached
 * input tokens.
 */
const INPUT_TOKEN_TYPE = 'input';
const CACHE_READ_TOKEN_TYPE = 'cache_read';
const CACHE_WRITE_TOKEN_TYPE = 'cache_write';
/**
 * Providers report no per-modality breakdown through the AI SDK usage object,
 * so GenAI token counters use the convention's `unknown` modality.
 */
const UNKNOWN_TOKEN_MODALITY = 'unknown';
/** Closed set of interaction tool error codes, exported as `error.type`. */
const TOOL_ERROR_TYPES = new Set([
  'tool-not-found',
  'tool-not-implemented',
  'timeout',
  'aborted',
  'execution-failed',
  'invalid-input',
  'invalid-output',
  'result-too-large',
]);
/** Closed set of `klex.retry.reason` values; free text never becomes a label. */
const OPERATION_RETRY_REASONS = ['turn_failure', 'unknown'] as const;
export type OperationRetryReason = (typeof OPERATION_RETRY_REASONS)[number];
const OPERATION_RETRY_REASON_SET: ReadonlySet<string> = new Set(
  OPERATION_RETRY_REASONS,
);
const TELEMETRY_LEVELS = ['no', 'basic', 'advanced', 'debug'] as const;
const TELEMETRY_LEVEL_VALUES: Record<MetricsTelemetryLevel, number> = {
  no: 0,
  basic: 1,
  advanced: 2,
  debug: 3,
};
export type MetricsTelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

/** Used when no endpoint is configured, so no network exporter exists. */
const DISCARDING_METRIC_EXPORTER: PushMetricExporter = {
  export: (_metrics, resultCallback) => resultCallback({ code: 0 }),
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};

export interface TelemetryMetricsDependencies {
  logging: ModuleLogger;
  /** OTLP metrics URL. Without it, collected metrics are discarded locally. */
  endpoint?: string;
  headers?: Record<string, string>;
  exporterFactory?: () => PushMetricExporter;
  dataDirectory: string;
  enabled: boolean;
  instanceId: string;
  serviceVersion?: string;
  resourceAttributes?: Record<string, string>;
  /**
   * Level-gated identity attributes merged into the resource of every
   * export (evaluated per export, so they follow runtime level changes).
   */
  dynamicResourceAttributes?: () => Record<string, string>;
  policy?: Readonly<Pick<TelemetryPolicy, 'getSnapshot'>>;
  exportIntervalMs?: number;
  performanceSampleIntervalMs?: number;
  filesystemSampleIntervalMs?: number;
}

export interface TelemetryMetrics {
  start(): Promise<void>;
  close(): Promise<void>;
  forceFlush(): Promise<void>;
  recordModelCall(usage: ModelCallUsage): void;
  recordOperationRetry(
    sessionId: string,
    operationName?: string,
    reason?: OperationRetryReason,
  ): void;
  registerSession(session: SessionTelemetryState): void;
  unregisterSession(sessionId: string): void;
  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void;
  recordSessionStateChange(sessionId: string, from: string, to: string): void;
  recordInboxChange(sessionId: string, delta: number): void;
  recordSessionLifecycle(
    sessionId: string,
    event: 'created' | 'closed' | 'unregistered',
  ): void;
  recordToolCall(
    sessionId: string,
    toolName: string,
    success: boolean,
    durationMs?: number,
    errorType?: string,
  ): void;
  setEnabled(enabled: boolean): Promise<void>;
  setLevel(level: MetricsTelemetryLevel): Promise<void>;
}

export interface SessionTelemetryState {
  id: string;
  name: string;
  kind: 'default' | 'god' | 'child';
  extensionIdentifier?: string;
  parentId?: string;
  active: boolean;
  runtimeState: string;
  historyLength: number;
  transformedHistoryLength: number;
  lastCallInputTokens?: number;
  lastCallCacheReadTokens?: number;
  lastCallCacheWriteTokens?: number;
  lastCallCacheReadRatio?: number;
  lastCallSource?: 'chat' | 'extension';
}

export interface ModelCallUsage {
  sessionId?: string | null;
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

class ControllableMetricReader extends MetricReader {
  private timer: NodeJS.Timeout | null = null;
  private exportPromise: Promise<void> | null = null;
  private enabled = false;

  constructor(
    private readonly exporter: PushMetricExporter,
    private readonly exportIntervalMs: number,
    private readonly exportTimeoutMs: number,
    private readonly dynamicResourceAttributes?: () => Record<string, string>,
  ) {
    super({
      aggregationSelector: exporter.selectAggregation?.bind(exporter),
      aggregationTemporalitySelector:
        exporter.selectAggregationTemporality?.bind(exporter),
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.timer = setInterval(() => void this.runOnce(), this.exportIntervalMs);
    this.timer.unref();
  }

  private async runOnce(): Promise<void> {
    if (!this.enabled || this.exportPromise)
      return this.exportPromise ?? undefined;
    const currentExport = this.collectAndExport();
    this.exportPromise = currentExport;
    try {
      await currentExport;
    } catch (error) {
      // Telemetry is fail-open: an unavailable collector must never create an
      // unhandled rejection or interrupt the application runtime.
      process.emitWarning(
        error instanceof Error ? error : new Error(String(error)),
        { type: 'TelemetryMetricExportWarning' },
      );
    } finally {
      if (this.exportPromise === currentExport) this.exportPromise = null;
    }
  }

  private async collectAndExport(): Promise<void> {
    const { resourceMetrics, errors } = await this.collect({
      timeoutMillis: this.exportTimeoutMs,
    });
    for (const error of errors) {
      // This logger-independent path avoids recursively reporting failures
      // through the telemetry pipeline that is failing.
      process.emitWarning(
        error instanceof Error ? error : new Error(String(error)),
        { type: 'TelemetryMetricCollectionWarning' },
      );
    }
    if (resourceMetrics.scopeMetrics.length === 0) return;
    const payload = this.withDynamicResource(resourceMetrics);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Metric export timed out')),
        this.exportTimeoutMs,
      );
      timeout.unref();
      this.exporter.export(payload, (result) => {
        clearTimeout(timeout);
        if (result.code === 0) resolve();
        else reject(result.error ?? new Error('Metric export failed'));
      });
    });
  }

  private withDynamicResource(
    resourceMetrics: ResourceMetrics,
  ): ResourceMetrics {
    let dynamic: Record<string, string> = {};
    try {
      dynamic = this.dynamicResourceAttributes?.() ?? {};
    } catch {
      // Telemetry is fail-open: export without the optional attributes.
    }
    if (Object.keys(dynamic).length === 0) return resourceMetrics;
    return {
      ...resourceMetrics,
      resource: resourceMetrics.resource.merge(
        createTelemetryResourceFromAttributes(dynamic),
      ),
    };
  }

  protected async onForceFlush(): Promise<void> {
    if (this.exportPromise) await this.exportPromise;
    if (this.enabled) await this.runOnce();
    await this.exporter.forceFlush();
  }

  protected async onShutdown(): Promise<void> {
    const wasEnabled = this.enabled;
    this.setEnabled(false);
    if (this.exportPromise) await this.exportPromise;
    if (wasEnabled) {
      this.enabled = true;
      try {
        await this.runOnce();
      } finally {
        this.enabled = false;
      }
    }
    await this.exporter.shutdown();
  }
}

class TelemetryMetricsModule implements TelemetryMetrics {
  private provider: MeterProvider | null = null;
  private globalProviderRegistered = false;
  private reader: ControllableMetricReader | null = null;
  private performanceTimer: NodeJS.Timeout | null = null;
  private filesystemTimer: NodeJS.Timeout | null = null;
  private filesystemSample: Promise<void> | null = null;
  private filesystemGeneration = 0;
  private started = false;
  private lastCpu = process.cpuUsage();
  private lastSampleAt = process.hrtime.bigint();
  private latestMemoryRssBytes = 0;
  private latestCpuUserUtilization = 0;
  private latestCpuSystemUtilization = 0;
  private dataDirectoryBytes = 0;
  private inputTokenUsage: Counter | null = null;
  private outputTokenUsage: Counter | null = null;
  private cacheReadTokenUsage: Counter | null = null;
  private cacheWriteTokenUsage: Counter | null = null;
  private inputTokensPerOperation: Histogram | null = null;
  private outputTokensPerOperation: Histogram | null = null;
  private ttft: Histogram | null = null;
  private duration: Histogram | null = null;
  private level: MetricsTelemetryLevel = 'no';
  private memorySamples: Histogram | null = null;
  private cpuSamples: Histogram | null = null;
  private telemetryLevel: ObservableGauge | null = null;
  private sessionActive: ObservableGauge | null = null;
  private sessionRuntimeState: ObservableGauge | null = null;
  private sessionHistoryLength: ObservableGauge | null = null;
  private sessionTransformedHistoryLength: ObservableGauge | null = null;
  private sessionLastCallTokens: ObservableGauge | null = null;
  private sessionLastCallCacheReadRatio: ObservableGauge | null = null;
  private toolDuration: Histogram | null = null;
  private operationRetries: Counter | null = null;
  private sessionStateChanges: Counter | null = null;
  private inboxChanges: UpDownCounter | null = null;
  private sessionLifecycle: Counter | null = null;
  private queueOverflow: Counter | null = null;
  private closed = false;
  private pendingLevel: MetricsTelemetryLevel | null = null;
  private transitionPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, SessionTelemetryState>();
  private readonly terminalSessionTimestamps = new Map<string, number>();
  private readonly metricToolNames = new Set<string>();
  // Node does not expose portable per-process network byte counters. We do not
  // substitute system-wide counters because that would misattribute traffic.

  constructor(private readonly deps: TelemetryMetricsDependencies) {
    this.level = deps.enabled ? 'basic' : 'no';
  }

  /** Collection is enabled for every level except `no`; `level` is the only state. */
  private get enabled(): boolean {
    return this.level !== 'no';
  }

  async start(): Promise<void> {
    if (this.provider) {
      if (this.enabled && !this.started) this.activate();
      return;
    }

    const exportIntervalMs =
      this.deps.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS;
    const performanceSampleIntervalMs =
      this.deps.performanceSampleIntervalMs ??
      DEFAULT_PERFORMANCE_SAMPLE_INTERVAL_MS;
    const filesystemSampleIntervalMs =
      this.deps.filesystemSampleIntervalMs ??
      DEFAULT_FILESYSTEM_SAMPLE_INTERVAL_MS;
    const exporter =
      this.deps.exporterFactory?.() ??
      (this.deps.endpoint
        ? new OTLPMetricExporter({
            url: this.deps.endpoint,
            headers: this.deps.headers,
          })
        : DISCARDING_METRIC_EXPORTER);
    const reader = new ControllableMetricReader(
      exporter,
      exportIntervalMs,
      Math.min(exportIntervalMs, 10_000),
      this.deps.dynamicResourceAttributes,
    );
    this.reader = reader;
    const provider = new MeterProvider({
      resource: createTelemetryResourceFromAttributes(
        this.deps.resourceAttributes ?? {
          'service.name': 'klex',
          'service.namespace': 'stagewise',
          ...(this.deps.serviceVersion
            ? { 'service.version': this.deps.serviceVersion }
            : {}),
          'service.instance.id': this.deps.instanceId,
        },
      ),
      readers: [reader],
      views: [
        ...[
          'gen_ai.client.inference.operation.input_tokens',
          'gen_ai.client.inference.operation.output_tokens',
        ].map((instrumentName) => ({
          instrumentName,
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const,
            options: { boundaries: TOKEN_BUCKET_BOUNDARIES },
          },
        })),
        {
          instrumentName: 'gen_ai.execute_tool.duration',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: DURATION_BUCKET_BOUNDARIES },
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
    this.telemetryLevel = meter.createObservableGauge('klex.telemetry.level', {
      description: 'Active telemetry level: 0 no, 1 basic, 2 advanced, 3 debug',
      unit: '1',
    });
    this.telemetryLevel.addCallback((observable) => {
      if (!this.started || !this.enabled) return;
      observable.observe(TELEMETRY_LEVEL_VALUES[this.level], {
        'klex.telemetry.level.name': this.level,
      });
    });
    // OTel GenAI token metrics: counters for cumulative usage (cache counters
    // are subsets of input) and per-operation histograms for distributions.
    this.inputTokenUsage = meter.createCounter(
      'gen_ai.client.inference.usage.input_tokens',
      {
        description:
          'The number of input (prompt) tokens used, including cached tokens',
        unit: '{token}',
      },
    );
    this.outputTokenUsage = meter.createCounter(
      'gen_ai.client.inference.usage.output_tokens',
      {
        description:
          'The number of output (completion) tokens used, including reasoning tokens',
        unit: '{token}',
      },
    );
    this.cacheReadTokenUsage = meter.createCounter(
      'gen_ai.client.inference.usage.cache_read.input_tokens',
      {
        description:
          'The number of input tokens served from a provider-managed cache',
        unit: '{token}',
      },
    );
    this.cacheWriteTokenUsage = meter.createCounter(
      'gen_ai.client.inference.usage.cache_write.input_tokens',
      {
        description:
          'The number of input tokens written to a provider-managed cache',
        unit: '{token}',
      },
    );
    this.inputTokensPerOperation = meter.createHistogram(
      'gen_ai.client.inference.operation.input_tokens',
      {
        description:
          'The number of input (prompt) tokens used per inference operation',
        unit: '{token}',
      },
    );
    this.outputTokensPerOperation = meter.createHistogram(
      'gen_ai.client.inference.operation.output_tokens',
      {
        description:
          'The number of output (completion) tokens used per inference operation',
        unit: '{token}',
      },
    );
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
    meter
      .createObservableGauge('process.uptime', {
        description: 'Time the Klex process has been running',
        unit: 's',
      })
      .addCallback((observable) => {
        if (!this.started || !this.enabled) return;
        observable.observe(process.uptime());
      });
    meter
      .createObservableGauge('klex.host.logical_processor.count', {
        description: 'Logical processors available to the Klex process',
        unit: '{processor}',
      })
      .addCallback((observable) => {
        if (!this.started || !isDetailedLevel(this.currentLevel())) return;
        observable.observe(availableParallelism());
      });
    meter
      .createObservableGauge('klex.host.memory.capacity', {
        description: 'Host memory capacity visible to the Klex process',
        unit: 'By',
      })
      .addCallback((observable) => {
        if (!this.started || !isDetailedLevel(this.currentLevel())) return;
        observable.observe(totalmem(), {
          'klex.memory.state': 'total',
        });
        observable.observe(freemem(), {
          'klex.memory.state': 'available',
        });
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
    this.queueOverflow = meter.createCounter(
      'klex.interaction.queue.overflow',
      {
        description: 'Interaction queue overflow events',
        unit: '{event}',
      },
    );
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
      description: 'Whether each known session is currently working',
      unit: '1',
    });
    this.sessionActive.addCallback((observable) => {
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
      for (const session of this.sessions.values()) {
        observable.observe(
          session.runtimeState === 'working' ? 1 : 0,
          sessionAttributes(session),
        );
      }
    });
    this.sessionRuntimeState = meter.createObservableGauge(
      'klex.session.runtime_state',
      {
        description:
          'Numeric runtime state of each known session: 0 idle, 1 working, 2 retrying, 3 leased, 4 success, 5 terminated',
        unit: '1',
      },
    );
    this.sessionRuntimeState.addCallback((observable) => {
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
      this.pruneTerminalSessions();
      for (const session of this.sessions.values()) {
        observable.observe(
          runtimeStateValue(session.runtimeState),
          sessionAttributes(session),
        );
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
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
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
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
      for (const session of this.sessions.values()) {
        observable.observe(
          session.transformedHistoryLength,
          sessionAttributes(session),
        );
      }
    });
    this.sessionLastCallTokens = meter.createObservableGauge(
      'klex.session.last_call.tokens',
      {
        description:
          'Provider-reported tokens in the most recently completed model call for each active session, partitioned by klex.token.type (cache types are subsets of input)',
        unit: '{token}',
      },
    );
    this.sessionLastCallTokens.addCallback((observable) => {
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
      for (const session of this.sessions.values()) {
        const attributes = sessionLastCallAttributes(session);
        for (const [tokenType, value] of [
          [INPUT_TOKEN_TYPE, session.lastCallInputTokens],
          [CACHE_READ_TOKEN_TYPE, session.lastCallCacheReadTokens],
          [CACHE_WRITE_TOKEN_TYPE, session.lastCallCacheWriteTokens],
        ] as const) {
          if (value === undefined) continue;
          observable.observe(value, {
            ...attributes,
            'klex.token.type': tokenType,
          });
        }
      }
    });
    this.sessionLastCallCacheReadRatio = meter.createObservableGauge(
      'klex.session.last_call.cache_read_ratio',
      {
        description:
          'Fraction of last-call input tokens reported as cache reads for each active session',
        unit: '1',
      },
    );
    this.sessionLastCallCacheReadRatio.addCallback((observable) => {
      if (
        !this.started ||
        !this.enabled ||
        !isDetailedLevel(this.currentLevel())
      )
        return;
      for (const session of this.sessions.values()) {
        if (session.lastCallCacheReadRatio === undefined) continue;
        observable.observe(
          session.lastCallCacheReadRatio,
          sessionLastCallAttributes(session),
        );
      }
    });
    // Call and error counts derive from this histogram's count, split by
    // `error.type` (absent on success).
    this.toolDuration = meter.createHistogram('gen_ai.execute_tool.duration', {
      description: 'The duration of a single tool execution',
      unit: 's',
    });
    this.operationRetries = meter.createCounter('klex.operation.retries', {
      description: 'Retry attempts for Klex operations',
      unit: '{retry}',
    });
    this.sessionStateChanges = meter.createCounter(
      'klex.session.state.changes',
      {
        description: 'Runtime state transitions for each session',
        unit: '{transition}',
      },
    );
    this.inboxChanges = meter.createUpDownCounter(
      'klex.session.inbox.changes',
      {
        description: 'Items added to or removed from each session inbox',
        unit: '{item}',
      },
    );
    this.sessionLifecycle = meter.createCounter('klex.session.lifecycle', {
      description: 'Session lifecycle events',
      unit: '{event}',
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

    if (this.enabled) {
      this.activate(performanceSampleIntervalMs, filesystemSampleIntervalMs);
    }
  }

  private activate(
    performanceSampleIntervalMs = this.deps.performanceSampleIntervalMs ??
      DEFAULT_PERFORMANCE_SAMPLE_INTERVAL_MS,
    filesystemSampleIntervalMs = this.deps.filesystemSampleIntervalMs ??
      DEFAULT_FILESYSTEM_SAMPLE_INTERVAL_MS,
  ): void {
    if (this.started) return;
    this.started = true;
    setTelemetryActivityEnabled(true);
    this.reader?.setEnabled(true);
    setQueueOverflowRecorder(() => {
      if (this.started && this.enabled) this.queueOverflow?.add(1);
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
    const advanced = isDetailedLevel(this.currentLevel());
    if (advanced && usage.sessionId) {
      const session = this.sessions.get(usage.sessionId);
      if (session) {
        session.lastCallInputTokens = usage.inputTokens;
        session.lastCallCacheReadTokens = usage.inputCacheReadTokens;
        session.lastCallCacheWriteTokens = usage.inputCacheWriteTokens;
        session.lastCallCacheReadRatio =
          usage.inputTokens > 0
            ? usage.inputCacheReadTokens / usage.inputTokens
            : undefined;
        session.lastCallSource = usage.source;
      }
    }
    const metricContext = context.active();
    const dimensions = {
      'gen_ai.operation.name': usage.operationName ?? 'generate_content',
      'gen_ai.provider.name': normalizeProviderName(
        usage.providerName ?? 'unknown',
      ),
    };
    // Token counts are aggregate numbers without content, so every enabled
    // level exports them, including the cache subsets.
    const usageDimensions = {
      ...dimensions,
      'gen_ai.token.modality': UNKNOWN_TOKEN_MODALITY,
    };
    for (const [counter, value] of [
      [this.inputTokenUsage, usage.inputTokens],
      [this.outputTokenUsage, usage.outputTokens],
      [this.cacheReadTokenUsage, usage.inputCacheReadTokens],
      [this.cacheWriteTokenUsage, usage.inputCacheWriteTokens],
    ] as const) {
      if (value > 0) counter?.add(value, usageDimensions, metricContext);
    }
    // Failed and aborted calls carry no provider usage; recording their
    // placeholder zeros would distort the per-operation distributions.
    if (!usage.isError) {
      this.inputTokensPerOperation?.record(
        usage.inputTokens,
        dimensions,
        metricContext,
      );
      this.outputTokensPerOperation?.record(
        usage.outputTokens,
        dimensions,
        metricContext,
      );
    }
    if (usage.ttftMs !== undefined && usage.ttftMs !== null) {
      this.ttft?.record(usage.ttftMs / 1_000, dimensions, metricContext);
    }
    if (usage.totalDurationMs !== undefined && usage.totalDurationMs !== null) {
      const outcome = usage.isError
        ? usage.finishReason === 'aborted' || usage.finishReason === 'abort'
          ? 'aborted'
          : 'error'
        : 'success';
      this.duration?.record(
        usage.totalDurationMs / 1_000,
        {
          ...dimensions,
          'klex.outcome': outcome,
          ...(advanced && usage.source
            ? { 'klex.call.source': usage.source }
            : {}),
          // OTel: `error.type` is conditionally required when the operation
          // failed. The normalized value is a closed enum, so it is safe at
          // every enabled level.
          ...(usage.isError
            ? {
                'error.type': usage.errorType
                  ? normalizeErrorType(usage.errorType)
                  : '_OTHER',
              }
            : {}),
        },
        metricContext,
      );
    }
  }

  recordOperationRetry(
    sessionId: string,
    operationName = 'session_turn',
    reason: OperationRetryReason = 'unknown',
  ): void {
    if (!this.started || !this.enabled || !isDetailedLevel(this.currentLevel()))
      return;
    const session = this.sessions.get(sessionId);
    this.operationRetries?.add(
      1,
      {
        'klex.operation.name': operationName,
        // Guards untyped callers; the attribute must stay low-cardinality.
        'klex.retry.reason': OPERATION_RETRY_REASON_SET.has(reason)
          ? reason
          : '_OTHER',
        ...(session ? { 'klex.session.kind': session.kind } : {}),
      },
      context.active(),
    );
  }

  registerSession(session: SessionTelemetryState): void {
    if (
      this.deps.policy &&
      !this.deps.policy.getSnapshot().detailedMetricsEnabled
    ) {
      return;
    }
    this.terminalSessionTimestamps.delete(session.id);
    this.sessions.set(session.id, { ...session });
  }

  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Keep the terminal sample available to the next metric collection. The
    // backend needs this final point to render the session as ended rather
    // than making the series disappear while the session is still alive in
    // historical graphs.
    session.active = false;
    session.runtimeState = 'terminated';
    this.terminalSessionTimestamps.set(sessionId, Date.now());
  }

  private pruneTerminalSessions(): void {
    const cutoff = Date.now() - TERMINAL_SESSION_RETENTION_MS;
    for (const [sessionId, endedAt] of this.terminalSessionTimestamps) {
      if (endedAt <= cutoff) {
        this.terminalSessionTimestamps.delete(sessionId);
        this.sessions.delete(sessionId);
      }
    }
  }

  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void {
    if (
      this.deps.policy &&
      !this.deps.policy.getSnapshot().detailedMetricsEnabled
    ) {
      return;
    }
    const current = this.sessions.get(sessionId);
    if (!current) return;
    Object.assign(current, update);
  }

  recordSessionStateChange(sessionId: string, from: string, to: string): void {
    if (!this.started || !this.enabled || !isDetailedLevel(this.currentLevel()))
      return;
    const session = this.sessions.get(sessionId);
    this.sessionStateChanges?.add(
      1,
      {
        ...(session ? sessionRoleAttributes(session) : {}),
        'klex.session.state.from': from,
        'klex.session.state.to': to,
      },
      context.active(),
    );
  }

  recordInboxChange(sessionId: string, delta: number): void {
    if (
      !this.started ||
      !this.enabled ||
      !isDetailedLevel(this.currentLevel()) ||
      delta === 0
    )
      return;
    const session = this.sessions.get(sessionId);
    this.inboxChanges?.add(
      delta,
      session ? sessionRoleAttributes(session) : {},
      context.active(),
    );
  }

  recordSessionLifecycle(
    sessionId: string,
    event: 'created' | 'closed' | 'unregistered',
  ): void {
    if (!this.started || !this.enabled || !isDetailedLevel(this.currentLevel()))
      return;
    const session = this.sessions.get(sessionId);
    this.sessionLifecycle?.add(
      1,
      {
        ...(session ? sessionRoleAttributes(session) : {}),
        'klex.session.lifecycle.event': event,
      },
      context.active(),
    );
  }

  recordToolCall(
    sessionId: string,
    toolName: string,
    success: boolean,
    durationMs?: number,
    errorType?: string,
  ): void {
    if (!this.started || !this.enabled || !isDetailedLevel(this.currentLevel()))
      return;
    if (durationMs === undefined) return;
    const session = this.sessions.get(sessionId);
    this.toolDuration?.record(
      durationMs / 1_000,
      {
        ...(session ? sessionRoleAttributes(session) : {}),
        'gen_ai.tool.name': this.normalizeMetricToolName(toolName),
        'gen_ai.tool.type': 'function',
        ...(success
          ? {}
          : {
              'error.type':
                errorType && TOOL_ERROR_TYPES.has(errorType)
                  ? errorType
                  : '_OTHER',
            }),
      },
      context.active(),
    );
  }

  private normalizeMetricToolName(toolName: string): string {
    const normalized = normalizeMetricAttribute(toolName);
    if (this.metricToolNames.has(normalized)) return normalized;
    if (this.metricToolNames.size >= MAX_METRIC_TOOL_NAMES) return '_other';
    this.metricToolNames.add(normalized);
    return normalized;
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.setLevel(
      enabled ? (this.level === 'no' ? 'basic' : this.level) : 'no',
    );
  }

  async forceFlush(): Promise<void> {
    if (this.closed || !this.started) return;
    await this.provider?.forceFlush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.pendingLevel = null;
    await this.transitionPromise;
    const provider = this.provider;
    // Flush while collection callbacks are still active. Deactivating first
    // would make the callbacks return no data during provider shutdown.
    await provider?.forceFlush();
    this.closed = true;
    this.deactivate(false);
    if (provider) await provider.shutdown();
    this.level = 'no';
    this.sessions.clear();
    this.terminalSessionTimestamps.clear();
  }

  private deactivate(disableReader = true): void {
    if (!this.started && disableReader) this.reader?.setEnabled(false);
    this.started = false;
    this.filesystemGeneration += 1;
    setTelemetryActivityEnabled(false);
    setQueueOverflowRecorder(null);
    if (this.performanceTimer) clearInterval(this.performanceTimer);
    if (this.filesystemTimer) clearInterval(this.filesystemTimer);
    this.performanceTimer = null;
    this.filesystemTimer = null;
    if (disableReader) this.reader?.setEnabled(false);
  }

  setLevel(level: MetricsTelemetryLevel): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pendingLevel = level;
    if (!this.transitionPromise) {
      this.transitionPromise = this.processLevelTransitions().finally(() => {
        this.transitionPromise = null;
      });
    }
    return this.transitionPromise;
  }

  private async processLevelTransitions(): Promise<void> {
    while (!this.closed && this.pendingLevel !== null) {
      const level = this.pendingLevel;
      this.pendingLevel = null;
      if (this.level === level) continue;
      const previousLevel = this.level;
      try {
        this.level = level;
        if (this.enabled) {
          await this.start();
          if (this.level === level && this.enabled) this.activate();
        } else {
          this.deactivate();
        }
        if (!isDetailedLevel(level)) {
          this.sessions.clear();
          this.terminalSessionTimestamps.clear();
        }
      } catch (error) {
        this.level = previousLevel;
        if (this.enabled) this.activate();
        else this.deactivate();
        throw error;
      }
    }
  }

  private currentLevel(): MetricsTelemetryLevel {
    return this.deps.policy?.getSnapshot().level ?? this.level;
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

  private sampleDataDirectory(): Promise<void> {
    if (!this.started || !this.enabled) return Promise.resolve();
    if (this.filesystemSample) return this.filesystemSample;
    const generation = this.filesystemGeneration;
    const sample = this.collectDataDirectorySize(generation).finally(() => {
      if (this.filesystemSample === sample) this.filesystemSample = null;
    });
    this.filesystemSample = sample;
    return sample;
  }

  private async collectDataDirectorySize(generation: number): Promise<void> {
    try {
      const dataDirectoryBytes = await directorySize(this.deps.dataDirectory);
      if (
        generation !== this.filesystemGeneration ||
        !this.started ||
        !this.enabled
      )
        return;
      this.dataDirectoryBytes = dataDirectoryBytes;
    } catch (error) {
      if (generation !== this.filesystemGeneration) return;
      this.deps.logging.debug(
        { error },
        'Unable to sample data-directory size',
      );
    }
  }
}

function isDetailedLevel(level: MetricsTelemetryLevel): boolean {
  return level === 'advanced' || level === 'debug';
}

function runtimeStateValue(state: string): number {
  switch (state) {
    case 'working':
      return 1;
    case 'retrying':
      return 2;
    case 'leased':
      return 3;
    case 'success':
      return 4;
    case 'terminated':
      return 5;
    default:
      return 0;
  }
}

function normalizeMetricAttribute(value: string): string {
  const normalized = Array.from(value.trim(), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? '_' : character;
  })
    .join('')
    .slice(0, MAX_METRIC_ATTRIBUTE_LENGTH);
  return normalized || 'unknown';
}

/**
 * Bounded session role dimensions for counters and histograms. Per-session
 * ids are unbounded over time, so they only appear on the pruned per-session
 * gauges (`sessionAttributes`); traces carry them for drill-down.
 */
function sessionRoleAttributes(session: SessionTelemetryState): Attributes {
  return {
    'klex.session.name': normalizeMetricAttribute(session.name),
    'klex.session.kind': session.kind,
    ...(session.extensionIdentifier
      ? {
          'klex.session.extension': normalizeMetricAttribute(
            session.extensionIdentifier,
          ),
        }
      : {}),
  };
}

function sessionAttributes(session: SessionTelemetryState): Attributes {
  return {
    'klex.session.id': normalizeMetricAttribute(session.id),
    'klex.session.name': normalizeMetricAttribute(session.name),
    'klex.session.kind': session.kind,
    ...(session.extensionIdentifier
      ? {
          'klex.session.extension': normalizeMetricAttribute(
            session.extensionIdentifier,
          ),
        }
      : {}),
    ...(session.parentId
      ? { 'klex.session.parent.id': normalizeMetricAttribute(session.parentId) }
      : {}),
  };
}

function sessionLastCallAttributes(session: SessionTelemetryState): Attributes {
  return {
    ...sessionAttributes(session),
    ...(session.lastCallSource
      ? { 'klex.call.source': session.lastCallSource }
      : {}),
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
