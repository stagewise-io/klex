import type {
  LogLevel,
  ModuleLogger,
  OTelTransportControl,
  RootLogger,
} from '@stagewise/logger';

import {
  createTelemetryPolicy,
  type RuntimeTelemetryLevel,
  type TelemetryLogThreshold,
  type TelemetryPolicy,
} from '@/telemetry-policy';

import type { TelemetrySpanProcessor } from './span-processor';

export interface TelemetryManagerDependencies {
  logging: RootLogger;
  /**
   * Process-wide level resolved from CLI arguments and environment variables.
   * Fixed for the lifetime of the process; config is never consulted.
   */
  level: RuntimeTelemetryLevel;
  spanProcessor: TelemetrySpanProcessor;
  logTransport?: OTelTransportControl;
  metrics?: { setLevel(level: RuntimeTelemetryLevel): Promise<void> };
  tracing?: { setEnabled(enabled: boolean): Promise<void> };
  policy?: TelemetryPolicy;
}

export interface TelemetryManager {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Numeric tslog level above FATAL; blocks every record. */
const OTLP_LEVEL_OFF = 999;

/**
 * Translates the policy's log threshold into the OTLP transport minimum.
 * The level → threshold mapping itself lives only in the telemetry policy.
 */
export function otlpMinLevel(
  threshold: TelemetryLogThreshold,
): LogLevel | number {
  return threshold === 'OFF' ? OTLP_LEVEL_OFF : threshold;
}

class TelemetryManagerModule implements TelemetryManager {
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      level: RuntimeTelemetryLevel;
      spanProcessor: TelemetrySpanProcessor;
      logTransport?: OTelTransportControl;
      metrics?: { setLevel(level: RuntimeTelemetryLevel): Promise<void> };
      tracing?: { setEnabled(enabled: boolean): Promise<void> };
      policy: TelemetryPolicy;
    },
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.applyLevel(this.deps.level);
    return this.startPromise;
  }

  async close(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
  }

  private async applyLevel(level: RuntimeTelemetryLevel): Promise<void> {
    this.deps.policy.setLevel(level);
    this.deps.spanProcessor.setLevel(level);
    this.deps.logTransport?.setMinLevel(
      otlpMinLevel(this.deps.policy.getSnapshot().logThreshold),
    );
    await Promise.all([
      this.deps.metrics?.setLevel(level),
      this.deps.tracing?.setEnabled(
        this.deps.policy.getSnapshot().tracesEnabled,
      ),
    ]);
    if (level !== 'no') {
      this.deps.logger.info(
        { telemetryLevel: level },
        'Telemetry level applied',
      );
    }
  }
}

export function createTelemetryManager(
  deps: TelemetryManagerDependencies,
): TelemetryManager {
  return new TelemetryManagerModule({
    logger: deps.logging.child({
      name: 'telemetry-manager',
      bindings: { module: 'telemetry-manager' },
    }),
    level: deps.level,
    spanProcessor: deps.spanProcessor,
    logTransport: deps.logTransport,
    metrics: deps.metrics,
    tracing: deps.tracing,
    policy: deps.policy ?? createTelemetryPolicy('no'),
  });
}
