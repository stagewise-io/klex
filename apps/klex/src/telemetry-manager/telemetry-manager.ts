import type { LogLevel, ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type Config,
  getDefaultTelemetryLevel,
  type KlexConfig,
  type TelemetryLevel,
} from '@/config';

import type { TelemetrySpanProcessor } from './span-processor';

export interface TelemetryManagerDependencies {
  logging: RootLogger;
  config: Config;
  spanProcessor: TelemetrySpanProcessor;
}

export interface TelemetryManager {
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Maps a telemetry level to the minimum log level for the OTLP transport.
 * - `off` — a very high numeric level blocks all logs.
 * - `minimum` — only `ERROR` and `FATAL` logs are sent.
 * - `reduced` — `WARN` and above are sent (reduced volume; masking
 *   already handles sensitive keys).
 * - `full` — `undefined` restores the transport's default (receives
 *   everything the logger emits).
 */
function getOtlpMinLevel(level: TelemetryLevel): LogLevel | number | undefined {
  switch (level) {
    case 'off':
      return 999;
    case 'minimum':
      return 'ERROR';
    case 'reduced':
      return 'WARN';
    case 'full':
      return undefined;
  }
}

class TelemetryManagerModule implements TelemetryManager {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      rootLogger: RootLogger;
      config: Config;
      spanProcessor: TelemetrySpanProcessor;
    },
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;

    const level = this.resolveLevel(this.deps.config.get());
    this.applyLevel(level);

    this.unsubscribe = this.deps.config.subscribe((config) => {
      this.applyLevel(this.resolveLevel(config));
    });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private resolveLevel(config: Readonly<KlexConfig>): TelemetryLevel {
    return config.telemetry?.level ?? getDefaultTelemetryLevel();
  }

  private applyLevel(level: TelemetryLevel): void {
    this.deps.spanProcessor.setLevel(level);
    this.updateOtlpTransport(level);
    this.deps.logger.info({ telemetryLevel: level }, 'Telemetry level applied');
  }

  private updateOtlpTransport(level: TelemetryLevel): void {
    const transport = this.deps.rootLogger.settings.attachedTransports.find(
      (t) => t.name === 'otlp',
    );
    if (!transport) return;

    transport.minLevel = getOtlpMinLevel(level);
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
    rootLogger: deps.logging,
    config: deps.config,
    spanProcessor: deps.spanProcessor,
  });
}
