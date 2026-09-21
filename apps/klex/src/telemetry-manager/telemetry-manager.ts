import type { LogLevel, ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type Config,
  getDefaultTelemetryLevel,
  type KlexConfig,
  type RuntimeTelemetryLevel,
} from '@/config';

import type { TelemetrySpanProcessor } from './span-processor';

export interface TelemetryManagerDependencies {
  logging: RootLogger;
  config: Config;
  spanProcessor: TelemetrySpanProcessor;
  effectiveLevel?: RuntimeTelemetryLevel;
  onLevelChange?: (level: RuntimeTelemetryLevel) => Promise<void>;
}

export interface TelemetryManager {
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Maps a telemetry level to the minimum log level for the OTLP transport.
 * - `no` — a very high numeric level blocks all logs.
 * - `basic` — only `WARN` and above are sent.
 * - `advanced` — `INFO` and above are sent.
 * - `debug` — `undefined` restores the transport's default.
 */
function getOtlpMinLevel(
  level: RuntimeTelemetryLevel,
): LogLevel | number | undefined {
  switch (level) {
    case 'no':
      return 999;
    case 'basic':
      return 'WARN';
    case 'advanced':
      return 'INFO';
    case 'debug':
      return undefined;
  }
}

class TelemetryManagerModule implements TelemetryManager {
  private unsubscribe: (() => void) | null = null;
  private pendingLevel: RuntimeTelemetryLevel | null = null;
  private transitionPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      rootLogger: RootLogger;
      config: Config;
      spanProcessor: TelemetrySpanProcessor;
      effectiveLevel?: RuntimeTelemetryLevel;
      onLevelChange?: (level: RuntimeTelemetryLevel) => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;

    const level =
      this.deps.effectiveLevel ?? this.resolveLevel(this.deps.config.get());
    await this.requestLevel(level);

    this.unsubscribe = this.deps.config.subscribe((config) => {
      if (this.deps.effectiveLevel === undefined) {
        void this.requestLevel(this.resolveLevel(config)).catch((error) => {
          this.deps.logger.error(
            { error },
            'Failed to apply telemetry level change',
          );
        });
      }
    });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingLevel = null;
    await this.transitionPromise;
    this.transitionPromise = null;
  }

  private resolveLevel(config: Readonly<KlexConfig>): RuntimeTelemetryLevel {
    return config.telemetry?.level ?? getDefaultTelemetryLevel();
  }

  private requestLevel(level: RuntimeTelemetryLevel): Promise<void> {
    this.pendingLevel = level;
    if (!this.transitionPromise) {
      this.transitionPromise = this.processTransitions().finally(() => {
        this.transitionPromise = null;
        if (this.pendingLevel !== null) {
          void this.requestLevel(this.pendingLevel).catch((error) => {
            this.deps.logger.error(
              { error },
              'Failed to apply queued telemetry level change',
            );
          });
        }
      });
    }
    return this.transitionPromise;
  }

  private async processTransitions(): Promise<void> {
    while (this.pendingLevel !== null) {
      const level = this.pendingLevel;
      this.pendingLevel = null;
      await this.applyLevel(level);
    }
  }

  private async applyLevel(level: RuntimeTelemetryLevel): Promise<void> {
    this.deps.spanProcessor.setLevel(level);
    this.updateOtlpTransport(level);
    await this.deps.onLevelChange?.(level);
    if (level !== 'no') {
      this.deps.logger.info(
        { telemetryLevel: level },
        'Telemetry level applied',
      );
    }
  }

  private updateOtlpTransport(level: RuntimeTelemetryLevel): void {
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
    effectiveLevel: deps.effectiveLevel,
    onLevelChange: deps.onLevelChange,
  });
}
