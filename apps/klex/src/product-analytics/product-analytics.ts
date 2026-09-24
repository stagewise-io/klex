import { randomUUID } from 'node:crypto';

import { PostHog } from 'posthog-node';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type AnalyticsSessionHandle,
  NOOP_SESSION_HANDLE,
  SessionAggregator,
} from './aggregator';
import {
  type ResourceSample,
  type RuntimeInfo,
  readRuntimeInfo,
  sampleResources,
  windowResources,
} from './runtime';
import {
  USAGE_WINDOW_EVENT,
  USAGE_WINDOW_SCHEMA_VERSION,
  type UsageWindowProperties,
  usageWindowPropertiesSchema,
} from './schema';

declare const __KLEX_POSTHOG_KEY__: string | undefined;
declare const __KLEX_POSTHOG_HOST__: string | undefined;

export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';
export const WINDOW_INTERVAL_MS = 2 * 60 * 60 * 1_000;
export const SHUTDOWN_DEADLINE_MS = 3_000;

export type WindowReason = 'interval' | 'shutdown';

/**
 * Reads the build-time PostHog config. tsx and vitest runs have no define, so
 * the `typeof` guards resolve them to "no key" and analytics stay inert.
 */
export function resolvePostHogBuildConfig(): {
  apiKey: string | undefined;
  host: string;
} {
  const apiKey =
    typeof __KLEX_POSTHOG_KEY__ === 'string'
      ? __KLEX_POSTHOG_KEY__.trim() || undefined
      : undefined;
  const host =
    typeof __KLEX_POSTHOG_HOST__ === 'string' && __KLEX_POSTHOG_HOST__.trim()
      ? __KLEX_POSTHOG_HOST__.trim()
      : DEFAULT_POSTHOG_HOST;
  return { apiKey, host };
}

/** Delivery seam. Best effort: failures are logged, never retried. */
export interface ProductAnalyticsTransport {
  send(properties: UsageWindowProperties): Promise<void>;
  close(timeoutMs: number): Promise<void>;
}

export interface ProductAnalyticsDependencies {
  logging: RootLogger;
  apiKey: string | undefined;
  host: string;
  klexVersion: string;
  telemetryEnabledAtStart: boolean;
  cloudEnabled: boolean;
  /** Late-bound; read at interval flushes only. */
  getConnectedMcpCount: () => number | undefined;
  /** Late-bound; read at interval flushes only. */
  getCloudEnrolled: () => boolean | undefined;
  /** Test seam. Defaults to the PostHog transport. */
  createTransport?: (config: {
    apiKey: string;
    host: string;
    distinctId: string;
    logger: ModuleLogger;
  }) => ProductAnalyticsTransport;
  /** Monotonic clock in ms. Test seam. */
  now?: () => number;
  /** Test seam. Defaults to the live OS/Node readings. */
  runtimeInfo?: RuntimeInfo;
  /** Test seam. Defaults to Node's process counters. */
  sampleResources?: () => ResourceSample;
}

/** Narrow handle given to sessions. */
export interface ProductAnalyticsRecorder {
  openSession(): AnalyticsSessionHandle;
}

export interface ProductAnalytics extends ProductAnalyticsRecorder {
  start(): Promise<void>;
  close(): Promise<void>;
}

function createPostHogTransport(config: {
  apiKey: string;
  host: string;
  distinctId: string;
  logger: ModuleLogger;
}): ProductAnalyticsTransport {
  const client = new PostHog(config.apiKey, {
    host: config.host,
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
    requestTimeout: 10_000,
    fetchRetryCount: 2,
  });
  // `captureImmediate` resolves even on transport failure and emits `error`.
  client.on('error', (error: unknown) => {
    config.logger.debug({ error }, 'Product analytics send failed');
  });
  return {
    send: (properties) =>
      client.captureImmediate({
        distinctId: config.distinctId,
        event: USAGE_WINDOW_EVENT,
        properties,
        disableGeoip: true,
      }),
    close: (timeoutMs) => client.shutdown(timeoutMs),
  };
}

function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

class ProductAnalyticsModule implements ProductAnalytics {
  private readonly aggregator = new SessionAggregator();
  /** Random per process, memory only. Never persisted. */
  private readonly distinctId = randomUUID();
  private readonly now: () => number;
  private readonly sample: () => ResourceSample;
  private runtime: RuntimeInfo | undefined;
  private lastSample: ResourceSample | undefined;
  private transport: ProductAnalyticsTransport | undefined;
  private timer: NodeJS.Timeout | undefined;
  private windowStart = 0;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly deps: ProductAnalyticsDependencies & { apiKey: string },
    private readonly logger: ModuleLogger,
  ) {
    this.now = deps.now ?? (() => performance.now());
    this.sample = deps.sampleResources ?? sampleResources;
  }

  openSession(): AnalyticsSessionHandle {
    return this.closePromise
      ? NOOP_SESSION_HANDLE
      : this.aggregator.openSession();
  }

  async start(): Promise<void> {
    if (this.transport || this.closePromise) return;
    try {
      this.transport = (this.deps.createTransport ?? createPostHogTransport)({
        apiKey: this.deps.apiKey,
        host: this.deps.host,
        distinctId: this.distinctId,
        logger: this.logger,
      });
      this.runtime = this.deps.runtimeInfo ?? readRuntimeInfo();
      this.lastSample = this.sample();
      this.windowStart = this.now();
      this.timer = setInterval(() => {
        void this.flush('interval');
      }, WINDOW_INTERVAL_MS);
      this.timer.unref();
    } catch (error) {
      // Fail open: analytics must never block or crash startup.
      this.transport = undefined;
      this.logger.debug({ error }, 'Product analytics disabled');
    }
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      clearInterval(this.timer);
      const transport = this.transport;
      if (!transport) return;
      await withDeadline(
        this.flush('shutdown').then(() => transport.close(1_000)),
        SHUTDOWN_DEADLINE_MS,
      );
    })().catch((error: unknown) => {
      this.logger.debug({ error }, 'Product analytics close failed');
    });
    return this.closePromise;
  }

  private async flush(reason: WindowReason): Promise<void> {
    try {
      const properties = this.snapshot(reason);
      if (properties) await this.transport?.send(properties);
    } catch (error) {
      this.logger.debug({ error }, 'Product analytics flush failed');
    }
  }

  private snapshot(reason: WindowReason): UsageWindowProperties | undefined {
    // Sample first: if it throws, clock and baseline stay put and the next
    // window covers both periods consistently.
    const current = this.sample();
    const now = this.now();
    const windowMs = Math.max(0, now - this.windowStart);
    const durationS = Math.round(windowMs / 1_000);
    this.windowStart = now;
    const runtime = this.runtime;
    const previous = this.lastSample;
    this.lastSample = current;
    if (!runtime || !previous) return undefined;
    const resources = windowResources(previous, current, windowMs);
    const sessions = this.aggregator.snapshotAndReset();
    // MCP and cloud are already closed at shutdown, so report unknown then.
    const gauges =
      reason === 'interval'
        ? {
            mcp: read(this.deps.getConnectedMcpCount),
            enrolled: read(this.deps.getCloudEnrolled),
          }
        : { mcp: null, enrolled: null };

    const parsed = usageWindowPropertiesSchema.safeParse({
      $process_person_profile: false,
      schema_version: USAGE_WINDOW_SCHEMA_VERSION,
      klex_version: this.deps.klexVersion,
      window_reason: reason,
      window_duration_s: durationS,
      telemetry_enabled_at_start: this.deps.telemetryEnabledAtStart,
      cloud_enabled: this.deps.cloudEnabled,
      cloud_enrolled: gauges.enrolled,
      mcp_connected_count: gauges.mcp,
      sessions_active: sessions.sessionsActive,
      sessions_started: sessions.sessionsStarted,
      sessions_ended: sessions.sessionsEnded,
      turns_total: sessions.turnsTotal,
      steps_total: sessions.stepsTotal,
      turns_per_session_max: sessions.turnsPerSessionMax,
      steps_per_session_max: sessions.stepsPerSessionMax,
      os_platform: runtime.platform,
      os_arch: runtime.arch,
      os_release: runtime.release,
      node_version: runtime.nodeVersion,
      process_uptime_s: resources.uptimeS,
      cpu_avg_pct: resources.cpuAvgPct,
      memory_rss_mb: resources.rssMb,
      memory_heap_used_mb: resources.heapUsedMb,
      memory_rss_peak_mb: resources.rssPeakMb,
    });
    if (!parsed.success) {
      // Never send a partial event. Issue paths name keys only, not values.
      this.logger.debug(
        { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
        'Product analytics window dropped by schema validation',
      );
      return undefined;
    }
    return parsed.data;
  }
}

function read<T>(getter: () => T | undefined): T | null {
  try {
    return getter() ?? null;
  } catch {
    return null;
  }
}

class DisabledProductAnalytics implements ProductAnalytics {
  openSession(): AnalyticsSessionHandle {
    return NOOP_SESSION_HANDLE;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {}
}

/** No SDK instance, no timers. */
export function createDisabledProductAnalytics(): ProductAnalytics {
  return new DisabledProductAnalytics();
}

/**
 * Returns the real module only when analytics are enabled and a key was
 * compiled in; otherwise the inert no-op.
 */
export function createProductAnalytics(
  deps: ProductAnalyticsDependencies & { enabled: boolean },
): ProductAnalytics {
  const { apiKey } = deps;
  if (!deps.enabled || !apiKey) return createDisabledProductAnalytics();
  return new ProductAnalyticsModule(
    { ...deps, apiKey },
    deps.logging.child({
      name: 'product-analytics',
      bindings: { module: 'product-analytics' },
    }),
  );
}
