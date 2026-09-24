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
  AGENT_STARTED_EVENT,
  AGENT_STARTED_SCHEMA_VERSION,
  type AnalyticsEvent,
  agentStartedPropertiesSchema,
  type Deployment,
  ENROLLMENT_FINISHED_EVENT,
  ENROLLMENT_SCHEMA_VERSION,
  ENROLLMENT_STARTED_EVENT,
  type EnrollmentMethod,
  type EnrollmentOutcome,
  enrollmentFinishedPropertiesSchema,
  enrollmentStartedPropertiesSchema,
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
  /** Resolves `true` when PostHog accepted the event, `false` otherwise. */
  send(event: AnalyticsEvent): Promise<boolean>;
  close(timeoutMs: number): Promise<void>;
}

/** Enough of the key to tell projects apart in logs. The key is public. */
function keyPreview(apiKey: string): string {
  return `${apiKey.slice(0, 8)}…`;
}

export interface ProductAnalyticsDependencies {
  logging: RootLogger;
  apiKey: string | undefined;
  host: string;
  klexVersion: string;
  deployment: Deployment;
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

/**
 * One enrollment flow. Creating it sends `klex_enrollment_started`; the first
 * `finish()` sends `klex_enrollment_finished`. Never throws.
 */
export interface EnrollmentTracker {
  /** One enrollment request was rejected. Non-terminal: the flow may retry. */
  attemptFailed(): void;
  /** Terminal and idempotent: only the first call sends. */
  finish(outcome: EnrollmentOutcome): void;
}

export const NOOP_ENROLLMENT_TRACKER: EnrollmentTracker = Object.freeze({
  attemptFailed: () => {},
  finish: () => {},
});

/** Narrow handle given to enrollment UIs and cloud connectivity. */
export type TrackEnrollment = (method: EnrollmentMethod) => EnrollmentTracker;

export interface ProductAnalytics extends ProductAnalyticsRecorder {
  /** Creates the client and starts the window clock. Sends nothing. */
  start(): Promise<void>;
  /** Sends `klex_agent_started`. Once per process; later calls are ignored. */
  agentStarted(): void;
  trackEnrollment: TrackEnrollment;
  /** Aborts open enrollment flows, then flushes the shutdown window. */
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
  // `captureImmediate` resolves even on transport failure and only emits
  // `error`. Sends are sequential, so an error counter bracketing the call
  // attributes the failure to it. Only the message is kept: it carries the
  // HTTP status, never the key.
  let errors = 0;
  let lastError = '';
  client.on('error', (error: unknown) => {
    errors++;
    lastError = error instanceof Error ? error.message : String(error);
  });
  return {
    send: async ({ event, properties }) => {
      const before = errors;
      await client.captureImmediate({
        distinctId: config.distinctId,
        event,
        properties,
        disableGeoip: true,
      });
      if (errors === before) return true;
      config.logger.debug(
        { event, error: lastError },
        'Product analytics send failed',
      );
      return false;
    },
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
  private agentStartedSent = false;
  /** In-flight one-off events. Never awaited by callers; drained by close. */
  private readonly pending = new Set<Promise<void>>();
  private readonly openFlows = new Set<EnrollmentTracker>();
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
      this.logger.debug(
        {
          host: this.deps.host,
          key: keyPreview(this.deps.apiKey),
          deployment: this.deps.deployment,
        },
        'Product analytics enabled',
      );
    } catch (error) {
      // Fail open: analytics must never block or crash startup.
      this.transport = undefined;
      this.logger.debug({ error }, 'Product analytics disabled');
    }
  }

  agentStarted(): void {
    if (!this.transport || this.closePromise || this.agentStartedSent) return;
    this.agentStartedSent = true;
    // Fire and forget: a slow or unreachable PostHog must not delay startup.
    this.background(this.sendAgentStarted());
  }

  trackEnrollment(method: EnrollmentMethod): EnrollmentTracker {
    if (!this.transport || this.closePromise) return NOOP_ENROLLMENT_TRACKER;
    const startedAt = this.now();
    let failedAttempts = 0;
    let done = false;
    const flow: EnrollmentTracker = {
      attemptFailed: () => {
        if (!done) failedAttempts++;
      },
      finish: (outcome) => {
        if (done) return;
        done = true;
        this.openFlows.delete(flow);
        this.background(
          this.sendEnrollmentFinished({
            method,
            outcome,
            failedAttempts,
            durationS: Math.round(Math.max(0, this.now() - startedAt) / 1_000),
          }),
        );
      },
    };
    this.openFlows.add(flow);
    this.background(this.sendEnrollmentStarted(method));
    return flow;
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      clearInterval(this.timer);
      // A flow still open at shutdown was left without an answer.
      for (const flow of [...this.openFlows]) flow.finish('aborted');
      const transport = this.transport;
      if (!transport) return;
      await withDeadline(
        Promise.allSettled([...this.pending])
          .then(() => this.flush('shutdown'))
          .then(() => transport.close(1_000)),
        SHUTDOWN_DEADLINE_MS,
      );
    })().catch((error: unknown) => {
      this.logger.debug({ error }, 'Product analytics close failed');
    });
    return this.closePromise;
  }

  private background(send: Promise<void>): void {
    this.pending.add(send);
    void send.finally(() => this.pending.delete(send));
  }

  private async sendEnrollmentStarted(method: EnrollmentMethod): Promise<void> {
    try {
      const runtime = this.runtime;
      if (!runtime) return;
      const parsed = enrollmentStartedPropertiesSchema.safeParse({
        ...this.baseProperties(runtime),
        schema_version: ENROLLMENT_SCHEMA_VERSION,
        enrollment_method: method,
      });
      if (!parsed.success) {
        this.logDropped(ENROLLMENT_STARTED_EVENT, parsed.error.issues);
        return;
      }
      await this.deliver({
        event: ENROLLMENT_STARTED_EVENT,
        properties: parsed.data,
      });
    } catch (error) {
      this.logger.debug({ error }, 'Product analytics enrollment event failed');
    }
  }

  private async sendEnrollmentFinished(flow: {
    method: EnrollmentMethod;
    outcome: EnrollmentOutcome;
    failedAttempts: number;
    durationS: number;
  }): Promise<void> {
    try {
      const runtime = this.runtime;
      if (!runtime) return;
      const parsed = enrollmentFinishedPropertiesSchema.safeParse({
        ...this.baseProperties(runtime),
        schema_version: ENROLLMENT_SCHEMA_VERSION,
        enrollment_method: flow.method,
        enrollment_outcome: flow.outcome,
        failed_attempts: flow.failedAttempts,
        duration_s: flow.durationS,
      });
      if (!parsed.success) {
        this.logDropped(ENROLLMENT_FINISHED_EVENT, parsed.error.issues);
        return;
      }
      await this.deliver({
        event: ENROLLMENT_FINISHED_EVENT,
        properties: parsed.data,
      });
    } catch (error) {
      this.logger.debug({ error }, 'Product analytics enrollment event failed');
    }
  }

  private async sendAgentStarted(): Promise<void> {
    try {
      const runtime = this.runtime;
      if (!runtime) return;
      const parsed = agentStartedPropertiesSchema.safeParse({
        ...this.baseProperties(runtime),
        schema_version: AGENT_STARTED_SCHEMA_VERSION,
      });
      if (!parsed.success) {
        this.logDropped(AGENT_STARTED_EVENT, parsed.error.issues);
        return;
      }
      await this.deliver({
        event: AGENT_STARTED_EVENT,
        properties: parsed.data,
      });
    } catch (error) {
      this.logger.debug({ error }, 'Product analytics start event failed');
    }
  }

  private async flush(reason: WindowReason): Promise<void> {
    try {
      const properties = this.snapshot(reason);
      if (properties) {
        await this.deliver({ event: USAGE_WINDOW_EVENT, properties });
      }
    } catch (error) {
      this.logger.debug({ error }, 'Product analytics flush failed');
    }
  }

  private async deliver(event: AnalyticsEvent): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    if (await transport.send(event)) {
      this.logger.debug(
        {
          event: event.event,
          reason:
            event.event === USAGE_WINDOW_EVENT
              ? event.properties.window_reason
              : event.event === ENROLLMENT_FINISHED_EVENT
                ? event.properties.enrollment_outcome
                : undefined,
        },
        'Product analytics event sent',
      );
    }
  }

  private baseProperties(runtime: RuntimeInfo) {
    return {
      $process_person_profile: false as const,
      klex_version: this.deps.klexVersion,
      deployment: this.deps.deployment,
      telemetry_enabled_at_start: this.deps.telemetryEnabledAtStart,
      cloud_enabled: this.deps.cloudEnabled,
      os_platform: runtime.platform,
      os_arch: runtime.arch,
      os_release: runtime.release,
      node_version: runtime.nodeVersion,
    };
  }

  private logDropped(
    event: string,
    issues: readonly { path: readonly PropertyKey[] }[],
  ): void {
    // Never send a partial event. Issue paths name keys only, not values.
    this.logger.debug(
      { event, issues: issues.map((issue) => issue.path.join('.')) },
      'Product analytics event dropped by schema validation',
    );
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
      ...this.baseProperties(runtime),
      schema_version: USAGE_WINDOW_SCHEMA_VERSION,
      window_reason: reason,
      window_duration_s: durationS,
      cloud_enrolled: gauges.enrolled,
      mcp_connected_count: gauges.mcp,
      sessions_active: sessions.sessionsActive,
      sessions_started: sessions.sessionsStarted,
      sessions_ended: sessions.sessionsEnded,
      turns_total: sessions.turnsTotal,
      steps_total: sessions.stepsTotal,
      turns_per_session_max: sessions.turnsPerSessionMax,
      steps_per_session_max: sessions.stepsPerSessionMax,
      process_uptime_s: resources.uptimeS,
      cpu_avg_pct: resources.cpuAvgPct,
      memory_rss_mb: resources.rssMb,
      memory_heap_used_mb: resources.heapUsedMb,
      memory_rss_peak_mb: resources.rssPeakMb,
    });
    if (!parsed.success) {
      this.logDropped(USAGE_WINDOW_EVENT, parsed.error.issues);
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

  agentStarted(): void {}

  trackEnrollment(): EnrollmentTracker {
    return NOOP_ENROLLMENT_TRACKER;
  }

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
  const logger = deps.logging.child({
    name: 'product-analytics',
    bindings: { module: 'product-analytics' },
  });
  const { apiKey } = deps;
  if (!deps.enabled || !apiKey) {
    logger.debug(
      { reason: deps.enabled ? 'no-key' : 'opted-out' },
      'Product analytics disabled',
    );
    return createDisabledProductAnalytics();
  }
  return new ProductAnalyticsModule({ ...deps, apiKey }, logger);
}
