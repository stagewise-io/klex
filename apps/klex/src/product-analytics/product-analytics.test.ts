import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  createDisabledProductAnalytics,
  createProductAnalytics,
  type ProductAnalyticsDependencies,
  type ProductAnalyticsTransport,
  SHUTDOWN_DEADLINE_MS,
  WINDOW_INTERVAL_MS,
} from './product-analytics';
import type { ResourceSample } from './runtime';
import {
  AGENT_STARTED_EVENT,
  type AnalyticsEvent,
  agentStartedPropertiesSchema,
  ENROLLMENT_FINISHED_EVENT,
  ENROLLMENT_STARTED_EVENT,
  enrollmentFinishedPropertiesSchema,
  enrollmentStartedPropertiesSchema,
  resolveDeployment,
  USAGE_WINDOW_EVENT,
  type UsageWindowProperties,
  usageWindowPropertiesSchema,
} from './schema';

const logging = createLogger({ name: 'klex', type: 'hidden' });
const API_KEY = 'phc_test_key';
const MB = 1024 * 1024;

/** Uses 30 % of one core over real fake-timer time, RSS 400 MB, peak 600 MB. */
function fakeResources(): () => ResourceSample {
  return () => ({
    cpuMicros: Date.now() * 1_000 * 0.3,
    rssBytes: 400 * MB,
    heapUsedBytes: 120 * MB,
    peakRssKb: 600 * 1024,
    uptimeS: Date.now() / 1_000,
  });
}

function fakeTransport(hang = false) {
  const events: AnalyticsEvent[] = [];
  /** Usage windows only, in send order. */
  const sent: UsageWindowProperties[] = [];
  const transport: ProductAnalyticsTransport = {
    send: vi.fn(async (event: AnalyticsEvent) => {
      if (hang) return new Promise<boolean>(() => undefined);
      events.push(event);
      if (event.event === USAGE_WINDOW_EVENT) sent.push(event.properties);
      return true;
    }),
    close: vi.fn(async () => undefined),
  };
  return { events, sent, transport };
}

function deps(
  transport: ProductAnalyticsTransport,
  overrides: Partial<ProductAnalyticsDependencies & { enabled: boolean }> = {},
) {
  return {
    enabled: true,
    logging,
    apiKey: API_KEY,
    host: 'https://eu.i.posthog.com',
    klexVersion: '0.0.0-test',
    deployment: 'self_hosted' as const,
    telemetryEnabledAtStart: false,
    cloudEnabled: true,
    getConnectedMcpCount: () => 2,
    getCloudEnrolled: () => true,
    createTransport: vi.fn(() => transport),
    now: () => Date.now(),
    runtimeInfo: {
      platform: 'linux',
      arch: 'x64',
      release: '6',
      nodeVersion: '24.1.0',
    },
    sampleResources: fakeResources(),
    ...overrides,
  };
}

describe('product analytics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends no usage window when no agent was started', async () => {
    // Picker quit or failed startup: no window, not even at close.
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    await analytics.close();
    expect(fake.transport.send).not.toHaveBeenCalled();
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  it('starts the window clock at agentStarted(), not at start()', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    // Time spent in the agent picker.
    await vi.advanceTimersByTimeAsync(60_000);
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.window_duration_s).toBe(WINDOW_INTERVAL_MS / 1_000);
    await analytics.close();
    expect(fake.events.map((event) => event.event)).toEqual([
      AGENT_STARTED_EVENT,
      USAGE_WINDOW_EVENT,
      USAGE_WINDOW_EVENT,
    ]);
  });

  it('sends one agent-started event per process', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(
      deps(fake.transport, { deployment: 'cloud' }),
    );
    await analytics.start();
    analytics.agentStarted();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.events).toHaveLength(1);
    const [started] = fake.events;
    expect(started?.event).toBe(AGENT_STARTED_EVENT);
    expect(Object.keys(started?.properties ?? {}).sort()).toEqual(
      Object.keys(agentStartedPropertiesSchema.shape).sort(),
    );
    expect(started?.properties).toMatchObject({
      $process_person_profile: false,
      deployment: 'cloud',
      klex_version: '0.0.0-test',
      os_platform: 'linux',
    });
    await analytics.close();
    // Start event first, then exactly one shutdown window.
    expect(fake.events.map((event) => event.event)).toEqual([
      AGENT_STARTED_EVENT,
      USAGE_WINDOW_EVENT,
    ]);
  });

  it('does not block on a hanging agent-started event', async () => {
    const fake = fakeTransport(true);
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    expect(analytics.agentStarted()).toBeUndefined();
    expect(fake.transport.send).toHaveBeenCalledTimes(1);
    const closing = analytics.close();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await expect(closing).resolves.toBeUndefined();
  });

  it('sends the shutdown window even while an earlier send hangs', async () => {
    const events: string[] = [];
    const transport: ProductAnalyticsTransport = {
      send: vi.fn(async (event: AnalyticsEvent) => {
        if (event.event === AGENT_STARTED_EVENT) {
          return new Promise<boolean>(() => undefined);
        }
        events.push(event.event);
        return true;
      }),
      close: vi.fn(async () => undefined),
    };
    const analytics = createProductAnalytics(deps(transport));
    await analytics.start();
    analytics.agentStarted();
    const closing = analytics.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([USAGE_WINDOW_EVENT]);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    await closing;
  });

  it('waits for an in-flight interval window at close', async () => {
    let releaseWindow: (() => void) | undefined;
    const delivered: string[] = [];
    const transport: ProductAnalyticsTransport = {
      send: vi.fn(async (event: AnalyticsEvent) => {
        if (
          event.event === USAGE_WINDOW_EVENT &&
          event.properties.window_reason === 'interval'
        ) {
          await new Promise<void>((resolve) => {
            releaseWindow = resolve;
          });
        }
        delivered.push(
          event.event === USAGE_WINDOW_EVENT
            ? event.properties.window_reason
            : event.event,
        );
        return true;
      }),
      close: vi.fn(async () => undefined),
    };
    const analytics = createProductAnalytics(deps(transport));
    await analytics.start();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(releaseWindow).toBeDefined();

    let closed = false;
    const closing = analytics.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(transport.close).not.toHaveBeenCalled();
    releaseWindow?.();
    await closing;
    expect(delivered.sort()).toEqual(
      [AGENT_STARTED_EVENT, 'interval', 'shutdown'].sort(),
    );
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('ignores agentStarted() before start() and after close()', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    analytics.agentStarted();
    await analytics.start();
    await analytics.close();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.transport.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks a successful enrollment after failed attempts', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    const flow = analytics.trackEnrollment('agent_picker');
    await vi.advanceTimersByTimeAsync(0);

    const [started] = fake.events;
    expect(started?.event).toBe(ENROLLMENT_STARTED_EVENT);
    expect(Object.keys(started?.properties ?? {}).sort()).toEqual(
      Object.keys(enrollmentStartedPropertiesSchema.shape).sort(),
    );
    expect(started?.properties).toMatchObject({
      $process_person_profile: false,
      enrollment_method: 'agent_picker',
    });

    flow.attemptFailed();
    flow.attemptFailed();
    await vi.advanceTimersByTimeAsync(42_000);
    flow.finish('enrolled');
    flow.finish('aborted');
    flow.attemptFailed();
    await vi.advanceTimersByTimeAsync(0);

    const finished = fake.events.filter(
      (event) => event.event === ENROLLMENT_FINISHED_EVENT,
    );
    expect(finished).toHaveLength(1);
    expect(Object.keys(finished[0]?.properties ?? {}).sort()).toEqual(
      Object.keys(enrollmentFinishedPropertiesSchema.shape).sort(),
    );
    expect(finished[0]?.properties).toMatchObject({
      enrollment_method: 'agent_picker',
      enrollment_outcome: 'enrolled',
      failed_attempts: 2,
      duration_s: 42,
    });
    await analytics.close();
  });

  it.each([
    ['failed', 'token'],
    ['aborted', 'cloud_screen'],
  ] as const)('tracks a %s %s enrollment', async (outcome, method) => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    const flow = analytics.trackEnrollment(method);
    if (outcome === 'failed') flow.attemptFailed();
    flow.finish(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.events.at(-1)).toMatchObject({
      event: ENROLLMENT_FINISHED_EVENT,
      properties: {
        enrollment_method: method,
        enrollment_outcome: outcome,
        failed_attempts: outcome === 'failed' ? 1 : 0,
      },
    });
    await analytics.close();
  });

  it('aborts open enrollment flows on close and sends them first', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    const open = analytics.trackEnrollment('cloud_screen');
    analytics.trackEnrollment('agent_picker').finish('enrolled');

    await analytics.close();
    open.finish('enrolled');
    // Flows started after close are inert.
    analytics.trackEnrollment('token').finish('failed');
    await vi.advanceTimersByTimeAsync(0);

    const finished = fake.events.flatMap((event) =>
      event.event === ENROLLMENT_FINISHED_EVENT
        ? [
            `${event.properties.enrollment_method}:${event.properties.enrollment_outcome}`,
          ]
        : [],
    );
    expect(finished.sort()).toEqual([
      'agent_picker:enrolled',
      'cloud_screen:aborted',
    ]);
    // Enrollment only, no agent: no usage window.
    expect(fake.sent).toHaveLength(0);
    expect(fake.events).toHaveLength(4);
  });

  it('sends one privacy-safe event per 2 h window', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    analytics.agentStarted();
    const session = analytics.openSession();
    session.recordTurn(3);
    session.recordTurn(1);

    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);

    expect(fake.sent).toHaveLength(1);
    const [properties] = fake.sent;
    expect(Object.keys(properties ?? {}).sort()).toEqual(
      Object.keys(usageWindowPropertiesSchema.shape).sort(),
    );
    expect(properties).toMatchObject({
      $process_person_profile: false,
      deployment: 'self_hosted',
      window_reason: 'interval',
      window_duration_s: WINDOW_INTERVAL_MS / 1_000,
      cloud_enrolled: true,
      mcp_connected_count: 2,
      sessions_active: 1,
      turns_total: 2,
      steps_total: 4,
      os_platform: 'linux',
      os_arch: 'x64',
      os_release: '6',
      node_version: '24.1.0',
      cpu_avg_pct: 30,
      memory_rss_mb: 400,
      memory_heap_used_mb: 120,
      memory_rss_peak_mb: 600,
    });
    expect(JSON.stringify(properties)).not.toContain(API_KEY);
    await analytics.close();
  });

  it('flushes once on close with unknown gauges, and close is idempotent', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    analytics.agentStarted();
    analytics.openSession().recordTurn(1);

    const first = analytics.close();
    expect(analytics.close()).toBe(first);
    await first;

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      window_reason: 'shutdown',
      turns_total: 1,
      mcp_connected_count: null,
      cloud_enrolled: null,
      // Resource readings stay valid at shutdown.
      memory_rss_mb: 400,
      os_platform: 'linux',
    });
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respects the shutdown deadline with a hanging client', async () => {
    const fake = fakeTransport(true);
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
    analytics.agentStarted();

    let closed = false;
    const closing = analytics.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
  });

  it('does nothing when closed before start', async () => {
    const fake = fakeTransport();
    const options = deps(fake.transport);
    const analytics = createProductAnalytics(options);
    await analytics.close();
    await analytics.start();
    expect(options.createTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails open when the client cannot be created', async () => {
    const analytics = createProductAnalytics(
      deps(fakeTransport().transport, {
        createTransport: () => {
          throw new Error('boom');
        },
      }),
    );
    await expect(analytics.start()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    analytics.openSession().recordTurn(1);
    await expect(analytics.close()).resolves.toBeUndefined();
  });

  it('drops a window that fails schema validation instead of sending it', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(
      deps(fake.transport, { klexVersion: '' }),
    );
    await analytics.start();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(fake.transport.send).not.toHaveBeenCalled();
    await analytics.close();
  });

  it('drops a window whose runtime token fails validation', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(
      deps(fake.transport, {
        runtimeInfo: {
          platform: 'linux',
          arch: 'x64',
          release: 'contains spaces / paths',
          nodeVersion: '24.1.0',
        },
      }),
    );
    await analytics.start();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(fake.transport.send).not.toHaveBeenCalled();
    await analytics.close();
  });

  it('skips a window when resource sampling throws, without crashing', async () => {
    const fake = fakeTransport();
    let calls = 0;
    const analytics = createProductAnalytics(
      deps(fake.transport, {
        sampleResources: () => {
          calls++;
          if (calls === 2) throw new Error('boom');
          return fakeResources()();
        },
      }),
    );
    await analytics.start();
    analytics.agentStarted();
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    expect(fake.sent).toHaveLength(1);
    // The skipped window folds into the next one consistently.
    expect(fake.sent[0]).toMatchObject({
      window_duration_s: (2 * WINDOW_INTERVAL_MS) / 1_000,
      cpu_avg_pct: 30,
    });
    await analytics.close();
  });

  it.each([
    ['disabled', { enabled: false }],
    ['missing key', { apiKey: undefined }],
  ])('is fully inert when %s', async (_label, overrides) => {
    const fake = fakeTransport();
    const options = deps(fake.transport, overrides);
    const analytics = createProductAnalytics(options);
    await analytics.start();
    analytics.agentStarted();
    const flow = analytics.trackEnrollment('agent_picker');
    flow.attemptFailed();
    analytics.openSession().recordTurn(1);
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    await analytics.close();
    flow.finish('enrolled');
    expect(options.createTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [undefined, 'self_hosted'],
    ['', 'self_hosted'],
    ['  ', 'self_hosted'],
    ['cloud', 'cloud'],
    [' Cloud ', 'cloud'],
    ['self_hosted', 'self_hosted'],
    ['acme-prod-eu', 'other'],
    ['other', 'other'],
  ])('resolves KLEX_DEPLOYMENT %j to %s', (value, expected) => {
    expect(resolveDeployment(value)).toBe(expected);
  });

  it('provides an explicit no-op', async () => {
    const analytics = createDisabledProductAnalytics();
    await analytics.start();
    analytics.agentStarted();
    analytics.trackEnrollment('token').finish('enrolled');
    analytics.openSession().recordTurn(1);
    await analytics.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
