import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { registerTelemetry } from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { TelemetrySpanProcessor } from '@/telemetry-manager';

import { createKlexTelemetry } from './telemetry';

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
}

class TracingModule implements Tracing {
  private sdk: NodeSDK | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      otlpUrl: string;
      serviceName: string;
      resourceAttributes: Record<string, string>;
      spanProcessor: TelemetrySpanProcessor;
    },
  ) {}

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

    // Register a custom Telemetry integration that creates spans fitting
    // the klex trace hierarchy (session → turn → step → generation
    // → chat) instead of the AI SDK's default invoke_agent/step spans.
    const tracer = trace.getTracer(this.deps.serviceName);
    registerTelemetry(createKlexTelemetry(tracer));

    this.deps.logger.info(
      { otlpUrl: this.deps.otlpUrl, serviceName: this.deps.serviceName },
      'Tracing started',
    );
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
