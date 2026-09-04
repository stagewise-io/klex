import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelCallLogger, UsageDataPoint } from '@/model-call-logger';

import { setupTestApp } from './test-utils';
import { getUsage, getUsageRoute, type UsageRouteDependencies } from './usage';

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

function makeDataPoint(
  overrides: Partial<UsageDataPoint> = {},
): UsageDataPoint {
  return {
    bucket: '2026-08-14',
    splitKey: null,
    callCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    inputCacheWriteTokens: 0,
    inputCacheReadTokens: 0,
    ttftMs: 200,
    totalDurationMs: 1000,
    errorCount: 0,
    id: null,
    sessionId: null,
    providerId: null,
    endpointId: null,
    modelId: null,
    source: null,
    extensionId: null,
    finishReason: null,
    errorType: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeDeps(
  modelCallLogger: Partial<ModelCallLogger> = {},
): UsageRouteDependencies {
  return {
    modelCallLogger: {
      queryUsage: vi.fn(async () => []),
      ...modelCallLogger,
    } as unknown as ModelCallLogger,
    logger,
  };
}

function createApp(deps: UsageRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(getUsageRoute, getUsage(deps));
  });
}

// ---------------------------------------------------------------------------
// GET /v1/usage
// ---------------------------------------------------------------------------

describe('GET /v1/usage', () => {
  it('returns 200 with data points using default params', async () => {
    const dataPoints = [
      makeDataPoint(),
      makeDataPoint({ bucket: '2026-08-15', callCount: 3 }),
    ];
    const deps = makeDeps({
      queryUsage: vi.fn(async () => dataPoints),
    });
    const app = createApp(deps);
    const response = await app.request('/v1/usage');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ dataPoints });
  });

  it('passes splitBy=model through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?splitBy=model');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ splitBy: 'model' }),
    );
  });

  it('passes granularity=event through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?granularity=event');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'event' }),
    );
  });

  it('passes from and to datetime params through', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-31T23:59:59.999Z';
    await app.request(`/v1/usage?from=${from}&to=${to}`);
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ from, to }),
    );
  });

  it('passes custom limit through', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?granularity=event&limit=500');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });

  it('returns 400 for invalid splitBy value', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?splitBy=invalid');
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid granularity value', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?granularity=invalid');
    expect(response.status).toBe(400);
  });

  it('returns 500 when the logger throws', async () => {
    const deps = makeDeps({
      queryUsage: vi.fn(async () => {
        throw new Error('DB connection lost');
      }),
    });
    const app = createApp(deps);
    const response = await app.request('/v1/usage');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: 'Internal server error',
      code: 'internal_error',
    });
  });

  // --- Default values ---------------------------------------------------------

  it('applies default values when no query params are provided', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        splitBy: 'none',
        granularity: 'daily',
        limit: 1000,
        from: null,
        to: null,
      }),
    );
  });

  // --- splitBy passthrough ----------------------------------------------------

  it('passes splitBy=provider through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?splitBy=provider');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ splitBy: 'provider' }),
    );
  });

  it('passes splitBy=endpoint through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?splitBy=endpoint');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ splitBy: 'endpoint' }),
    );
  });

  it('passes splitBy=none through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?splitBy=none');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ splitBy: 'none' }),
    );
  });

  // --- granularity passthrough ------------------------------------------------

  it('passes granularity=hourly through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?granularity=hourly');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'hourly' }),
    );
  });

  it('passes granularity=weekly through to the logger', async () => {
    const queryUsage = vi.fn(async () => []);
    const deps = makeDeps({ queryUsage });
    const app = createApp(deps);
    await app.request('/v1/usage?granularity=weekly');
    expect(queryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'weekly' }),
    );
  });

  // --- limit boundary validation ----------------------------------------------

  it('returns 400 when limit is 0', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?limit=0');
    expect(response.status).toBe(400);
  });

  it('returns 400 when limit is negative', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?limit=-1');
    expect(response.status).toBe(400);
  });

  it('returns 400 when limit exceeds 10000', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?limit=10001');
    expect(response.status).toBe(400);
  });

  // --- datetime validation ----------------------------------------------------

  it('returns 400 for invalid from datetime', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?from=not-a-date');
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid to datetime', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request('/v1/usage?to=2026-13-45');
    expect(response.status).toBe(400);
  });

  it('returns 400 for datetime with timezone offset', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const response = await app.request(
      '/v1/usage?from=2026-01-01T00:00:00.000%2B02:00',
    );
    expect(response.status).toBe(400);
  });

  // --- response shape ---------------------------------------------------------

  it('returns dataPoints with correct schema fields', async () => {
    const dataPoints = [
      makeDataPoint({
        bucket: '2026-08-14',
        splitKey: 'gpt-4o',
        callCount: 3,
        inputTokens: 500,
        outputTokens: 200,
        inputCacheWriteTokens: 50,
        inputCacheReadTokens: 100,
        ttftMs: 250.5,
        totalDurationMs: 5000.0,
        errorCount: 1,
      }),
    ];
    const deps = makeDeps({
      queryUsage: vi.fn(async () => dataPoints),
    });
    const app = createApp(deps);
    const response = await app.request('/v1/usage');
    const body = (await response.json()) as { dataPoints: UsageDataPoint[] };
    expect(body.dataPoints[0]).toEqual({
      bucket: '2026-08-14',
      splitKey: 'gpt-4o',
      callCount: 3,
      inputTokens: 500,
      outputTokens: 200,
      inputCacheWriteTokens: 50,
      inputCacheReadTokens: 100,
      ttftMs: 250.5,
      totalDurationMs: 5000.0,
      errorCount: 1,
      id: null,
      sessionId: null,
      providerId: null,
      endpointId: null,
      modelId: null,
      source: null,
      extensionId: null,
      finishReason: null,
      errorType: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('returns null bucket and splitKey for event granularity with no split', async () => {
    const dataPoints = [makeDataPoint({ bucket: null, splitKey: null })];
    const deps = makeDeps({
      queryUsage: vi.fn(async () => dataPoints),
    });
    const app = createApp(deps);
    const response = await app.request('/v1/usage?granularity=event');
    const body = (await response.json()) as { dataPoints: UsageDataPoint[] };
    expect(body.dataPoints[0]!.bucket).toBeNull();
    expect(body.dataPoints[0]!.splitKey).toBeNull();
  });
});
