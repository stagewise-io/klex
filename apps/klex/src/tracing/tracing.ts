import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  SamplingDecision,
} from '@opentelemetry/sdk-trace-base';
import { registerTelemetry } from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { TelemetrySpanProcessor } from '@/telemetry-manager';
import type { TelemetryPolicy } from '@/telemetry-policy';
import { createTelemetryResourceFromAttributes } from '@/telemetry-resource';

import {
  createKlexTelemetry,
  type KlexTelemetry,
  type ModelCallSink,
} from './telemetry';

export interface TracingDependencies {
  logging: RootLogger;
  /** OTLP traces URL. Without it no exporter is ever created. */
  otlpUrl?: string;
  otlpHeaders?: Record<string, string>;
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  spanProcessor: TelemetrySpanProcessor;
  enabled?: boolean;
  /** Content capture is permitted only while the policy allows it (debug). */
  policy?: Readonly<Pick<TelemetryPolicy, 'getSnapshot'>>;
  /** Configured agent name, recorded as `gen_ai.agent.name` on model spans. */
  agentName?: string;
  /** Stable agent id (enrolled cloud client id), as `gen_ai.agent.id`. */
  getAgentId?: () => string | null | undefined;
}

export interface Tracing {
  start(): Promise<void>;
  forceFlush(): Promise<void>;
  close(): Promise<void>;
  setModelCallSink(sink: ModelCallSink | null): void;
  setEnabled(enabled: boolean): Promise<void>;
}

class TracingModule implements Tracing {
  private readonly provider: BasicTracerProvider;
  private exporterProcessor: BatchSpanProcessor | null = null;
  private providerShutdown = false;
  private readonly telemetryInstance: KlexTelemetry;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      otlpUrl: string | undefined;
      otlpHeaders: Record<string, string>;
      serviceName: string;
      resourceAttributes: Record<string, string>;
      spanProcessor: TelemetrySpanProcessor;
      enabled: boolean;
      policy?: Readonly<Pick<TelemetryPolicy, 'getSnapshot'>>;
      agentName?: string;
      getAgentId?: () => string | null | undefined;
    },
  ) {
    const resource = createTelemetryResourceFromAttributes({
      'service.name': deps.serviceName,
      ...deps.resourceAttributes,
    });
    const sampler: Sampler | undefined = deps.policy
      ? {
          shouldSample: () => ({
            // Spans are exported only at advanced/debug; skip recording
            // work entirely at no/basic.
            decision: deps.policy?.getSnapshot().tracesEnabled
              ? SamplingDecision.RECORD_AND_SAMPLED
              : SamplingDecision.NOT_RECORD,
          }),
          toString: () => 'TelemetryPolicySampler',
        }
      : undefined;
    this.provider = new BasicTracerProvider({
      resource,
      sampler,
      spanProcessors: [deps.spanProcessor],
    });
    // Register exactly one provider and context manager for this process.
    trace.setGlobalTracerProvider(this.provider);
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );

    const tracer = this.provider.getTracer(deps.serviceName);
    this.telemetryInstance = createKlexTelemetry(tracer, {
      contentAllowed: () => deps.policy?.getSnapshot().contentAllowed ?? false,
      agentName: deps.agentName,
      getAgentId: deps.getAgentId,
    });
    registerTelemetry(this.telemetryInstance);
  }

  async start(): Promise<void> {
    if (this.providerShutdown || !this.deps.enabled) return;
    if (this.exporterProcessor || !this.deps.otlpUrl) return;

    const exporter = new OTLPTraceExporter({
      url: this.deps.otlpUrl,
      headers: this.deps.otlpHeaders,
    });
    this.exporterProcessor = new BatchSpanProcessor(exporter, {
      scheduledDelayMillis: 5_000,
      exportTimeoutMillis: 10_000,
      maxQueueSize: 2_048,
      maxExportBatchSize: 512,
    });
    this.deps.spanProcessor.setDelegate(this.exporterProcessor);
    this.deps.logger.info(
      { otlpUrl: this.deps.otlpUrl, serviceName: this.deps.serviceName },
      'Tracing started',
    );
  }

  setModelCallSink(sink: ModelCallSink | null): void {
    this.telemetryInstance.setModelCallSink(sink);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.deps.enabled) return;
    this.deps.enabled = enabled;
    if (enabled) {
      await this.start();
      return;
    }
    await this.stopExporter();
  }

  private async stopExporter(): Promise<void> {
    const processor = this.exporterProcessor;
    this.exporterProcessor = null;
    this.deps.spanProcessor.setDelegate(null);
    if (processor) await processor.shutdown();
    this.deps.logger.info('Tracing stopped');
  }

  async forceFlush(): Promise<void> {
    if (this.providerShutdown) return;
    await this.deps.spanProcessor.forceFlush();
  }

  async close(): Promise<void> {
    if (this.providerShutdown) return;
    this.providerShutdown = true;
    await this.stopExporter();
    await this.provider.shutdown();
  }
}

export function createTracing(deps: TracingDependencies): Tracing {
  return new TracingModule({
    logger: deps.logging.child({
      name: 'tracing',
      bindings: { module: 'tracing' },
    }),
    otlpUrl: deps.otlpUrl,
    otlpHeaders: deps.otlpHeaders ?? {},
    serviceName: deps.serviceName,
    resourceAttributes: deps.resourceAttributes ?? {},
    spanProcessor: deps.spanProcessor,
    enabled: deps.enabled ?? true,
    policy: deps.policy,
    agentName: deps.agentName,
    getAgentId: deps.getAgentId,
  });
}
