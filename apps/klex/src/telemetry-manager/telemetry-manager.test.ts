import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  createTelemetryPolicy,
  type RuntimeTelemetryLevel,
} from '@/telemetry-policy';

import type { TelemetrySpanProcessor } from './span-processor';
import { createTelemetryManager } from './telemetry-manager';

function createDependencies() {
  const moduleLogger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const logging = {
    child: vi.fn(() => moduleLogger),
  } as unknown as RootLogger;
  const spanProcessor = {
    setLevel: vi.fn(),
  } as unknown as TelemetrySpanProcessor;
  const logTransport = { setMinLevel: vi.fn() };
  const metrics = { setLevel: vi.fn(async (): Promise<void> => undefined) };
  const tracing = { setEnabled: vi.fn(async () => undefined) };
  const policy = createTelemetryPolicy('no');

  return {
    moduleLogger,
    logging,
    spanProcessor,
    logTransport,
    metrics,
    tracing,
    policy,
  };
}

function createManager(
  deps: ReturnType<typeof createDependencies>,
  level: RuntimeTelemetryLevel,
) {
  return createTelemetryManager({
    logging: deps.logging,
    level,
    spanProcessor: deps.spanProcessor,
    logTransport: deps.logTransport,
    metrics: deps.metrics,
    tracing: deps.tracing,
    policy: deps.policy,
  });
}

describe('telemetry manager', () => {
  it.each([
    ['no', 999, false],
    // Traces are advanced/debug only.
    ['basic', 'WARN', false],
    ['advanced', 'INFO', true],
    ['debug', 'TRACE', true],
  ] as const)(
    'applies the %s pipeline configuration at startup',
    async (level, minimumLogLevel, tracingEnabled) => {
      const deps = createDependencies();
      const manager = createManager(deps, level);

      await manager.start();

      expect(deps.policy.getSnapshot().level).toBe(level);
      expect(deps.spanProcessor.setLevel).toHaveBeenCalledWith(level);
      expect(deps.logTransport.setMinLevel).toHaveBeenCalledWith(
        minimumLogLevel,
      );
      expect(deps.metrics.setLevel).toHaveBeenCalledWith(level);
      expect(deps.tracing.setEnabled).toHaveBeenCalledWith(tracingEnabled);

      await manager.close();
    },
  );

  it('applies the fixed level exactly once', async () => {
    const deps = createDependencies();
    const manager = createManager(deps, 'advanced');

    await Promise.all([manager.start(), manager.start()]);

    expect(deps.metrics.setLevel).toHaveBeenCalledOnce();
    expect(deps.logTransport.setMinLevel).toHaveBeenCalledOnce();
    await manager.close();
  });

  it('works without a log transport when telemetry is off', async () => {
    const deps = createDependencies();
    const manager = createTelemetryManager({
      logging: deps.logging,
      level: 'no',
      spanProcessor: deps.spanProcessor,
      metrics: deps.metrics,
      tracing: deps.tracing,
      policy: deps.policy,
    });

    await manager.start();

    expect(deps.policy.getSnapshot().level).toBe('no');
    expect(deps.tracing.setEnabled).toHaveBeenCalledWith(false);
    expect(deps.moduleLogger.info).not.toHaveBeenCalled();
    await manager.close();
  });
});
