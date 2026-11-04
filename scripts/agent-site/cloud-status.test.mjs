import { expect, it, vi } from 'vitest';

import { createCloudStatus } from './cloud-status.mjs';

it('caches successful requests and coalesces concurrent requests', async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ongoing_incidents: [],
      in_progress_maintenances: [],
      scheduled_maintenances: [],
    }),
  }));
  const status = createCloudStatus(fetcher);
  const results = await Promise.all([status.response(), status.response()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(results[0].status).toBe(200);
  expect(results[0].headers['Cache-Control']).toContain('max-age=30');
  await status.response();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  async () => {
    throw new Error('offline');
  },
  async () => ({ ok: false }),
  async () => ({ ok: true, json: async () => ({}) }),
])('fails safely without claiming operational status', async (fetcher) => {
  const result = await createCloudStatus(fetcher).response();
  expect(result.status).toBe(503);
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(result.body).not.toContain('operational');
  expect(result.headers['Content-Type']).toContain('application/problem+json');
  expect(JSON.parse(result.body)).toMatchObject({
    status: 503,
    code: 'STATUS_UNAVAILABLE',
    detail: expect.any(String),
    resolution: expect.stringContaining('https://status.klex.bot/'),
  });
});
