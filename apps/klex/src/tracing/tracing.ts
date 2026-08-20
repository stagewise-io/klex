import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
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
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  spanProcessor: TelemetrySpanProcessor;
}

export interface Tracing {
  start(): Promise<void>;
  close(): Promise<void>;
  setModelCallSink(sink: ModelCallSink | null): void;
}

class TracingModule implements Tracing {
  private sdk: NodeSDK | null = null;
  private started = false;
  private readonly telemetryInstance: KlexTelemetry;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      otlpUrl: string;
      serviceName: string;
      resourceAttributes: Record<string, string>;
      spanProcessor: TelemetrySpanProcessor;
    },
  ) {
    // Always register the custom telemetry integration so usage tracking
    // works even when OTel SDK startup is skipped (tracing disabled).
    // trace.getTracer returns a ProxyTracer that delegates to the global
    // provider — no-op before SDK start, real once it starts.
    const tracer = trace.getTracer(deps.serviceName);
    this.telemetryInstance = createKlexTelemetry(tracer);
    registerTelemetry(this.telemetryInstance);
  }

  async start(): Promise<void> {
    if (this.started) return;

    const exporter = new OTLPTraceExporter({
      url: this.deps.otlpUrl,
    });

    this.deps.spanProcessor.setDelegate(new SimpleSpanProcessor(exporter));

    const resource = resources.defaultResource().merge(
      resources.resourceFromAttributes({
        'service.name': this.deps.serviceName,
        ...this.deps.resourceAttributes,
      }),
    );

    this.sdk = new NodeSDK({
      resource,
      spanProcessors: [this.deps.spanProcessor],
    });

    this.sdk.start();
    this.started = true;

    this.deps.logger.info(
      { otlpUrl: this.deps.otlpUrl, serviceName: this.deps.serviceName },
      'Tracing started',
    );
  }

  setModelCallSink(sink: ModelCallSink | null): void {
    this.telemetryInstance.setModelCallSink(sink);
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.sdk) {
      await this.sdk.shutdown();
      this.sdk = null;
    }

    this.deps.logger.info('Tracing stopped');
  }
}

export function createTracing(deps: TracingDependencies): Tracing {
  return new TracingModule({
    logger: deps.logging.child({
      name: 'tracing',
      bindings: { module: 'tracing' },
    }),
    otlpUrl: deps.otlpUrl,
    serviceName: deps.serviceName,
    resourceAttributes: deps.resourceAttributes ?? {},
    spanProcessor: deps.spanProcessor,
  });
}
