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
  const sent: UsageWindowProperties[] = [];
  const transport: ProductAnalyticsTransport = {
    send: vi.fn(async (properties: UsageWindowProperties) => {
      if (hang) return new Promise<void>(() => undefined);
      sent.push(properties);
    }),
    close: vi.fn(async () => undefined),
  };
  return { sent, transport };
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

  it('sends one privacy-safe event per 2 h window', async () => {
    const fake = fakeTransport();
    const analytics = createProductAnalytics(deps(fake.transport));
    await analytics.start();
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
    analytics.openSession().recordTurn(1);
    await vi.advanceTimersByTimeAsync(WINDOW_INTERVAL_MS);
    await analytics.close();
    expect(options.createTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides an explicit no-op', async () => {
    const analytics = createDisabledProductAnalytics();
    await analytics.start();
    analytics.openSession().recordTurn(1);
    await analytics.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
