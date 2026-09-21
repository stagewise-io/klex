import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resources } from '@opentelemetry/sdk-node';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { registerTelemetry } from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { TelemetrySpanProcessor } from '@/telemetry-manager';

import {
  createKlexTelemetry,
  type KlexTelemetry,
  type ModelCallSink,
} from './telemetry';

export interface TracingDependencies {
  logging: RootLogger;
  otlpUrl: string;
  otlpHeaders?: Record<string, string>;
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  spanProcessor: TelemetrySpanProcessor;
  enabled?: boolean;
  recordContent?: boolean;
  contentAllowed?: () => boolean;
}

export interface Tracing {
  start(): Promise<void>;
  close(): Promise<void>;
  setModelCallSink(sink: ModelCallSink | null): void;
  setEnabled(enabled: boolean): Promise<void>;
}

class TracingModule implements Tracing {
  private readonly provider: BasicTracerProvider;
  private exporterProcessor: SimpleSpanProcessor | null = null;
  private providerShutdown = false;
  private readonly telemetryInstance: KlexTelemetry;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      otlpUrl: string;
      otlpHeaders: Record<string, string>;
      serviceName: string;
      resourceAttributes: Record<string, string>;
      spanProcessor: TelemetrySpanProcessor;
      enabled: boolean;
      recordContent: boolean;
      contentAllowed: () => boolean;
    },
  ) {
    const resource = resources.resourceFromAttributes({
      'service.name': deps.serviceName,
      ...deps.resourceAttributes,
    });
    this.provider = new BasicTracerProvider({
      resource,
      spanProcessors: [deps.spanProcessor],
    });
    // Register exactly one provider and context manager for this process.
    trace.setGlobalTracerProvider(this.provider);
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );

    const tracer = this.provider.getTracer(deps.serviceName);
    this.telemetryInstance = createKlexTelemetry(tracer, {
      recordContent: deps.recordContent,
      contentAllowed: deps.contentAllowed,
    });
    registerTelemetry(this.telemetryInstance);
  }

  async start(): Promise<void> {
    if (this.providerShutdown || !this.deps.enabled) return;
    if (this.exporterProcessor) return;

    const exporter = new OTLPTraceExporter({
      url: this.deps.otlpUrl,
      headers: this.deps.otlpHeaders,
    });
    this.exporterProcessor = new SimpleSpanProcessor(exporter);
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
    recordContent: deps.recordContent ?? false,
    contentAllowed: deps.contentAllowed ?? (() => deps.recordContent === true),
  });
}
