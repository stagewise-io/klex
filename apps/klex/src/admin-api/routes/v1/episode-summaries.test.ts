import { describe, expect, it, vi } from 'vitest';

import type {
  EpisodeSummary,
  EpisodeSummaryListOptions,
  EpisodeSummaryLog,
} from '@/session/chat/extensions/episode-summary';

import {
  listEpisodeSummaries,
  listEpisodeSummariesRoute,
} from './episode-summaries';
import { setupTestApp } from './test-utils';

const summary: EpisodeSummary = {
  episodeId: 'episode-2',
  title: 'Fixed the flaky login test',
  startedAt: '2026-10-02T10:00:00.000Z',
  endedAt: '2026-10-02T10:30:00.000Z',
  createdAt: '2026-10-02T10:31:00.000Z',
};

function createLog(available = true) {
  const list = vi.fn(async (_options: EpisodeSummaryListOptions) => ({
    items: [summary],
    nextCursor: summary.episodeId,
    hasMore: true,
  }));
  const log: EpisodeSummaryLog = { isAvailable: () => available, list };
  return { log, list };
}

function createApp(episodeSummaryLog: EpisodeSummaryLog) {
  return setupTestApp((app) => {
    app.openapi(
      listEpisodeSummariesRoute,
      listEpisodeSummaries({ episodeSummaryLog }),
    );
  });
}

describe('episode summaries route', () => {
  it('returns a page with the default limit', async () => {
    const { log, list } = createLog();
    const res = await createApp(log).request('/v1/episode-summaries');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summaries: [summary],
      nextCursor: summary.episodeId,
      hasMore: true,
    });
    expect(list).toHaveBeenCalledWith({ limit: 20 });
  });

  it('forwards limit and cursor', async () => {
    const { log, list } = createLog();
    const res = await createApp(log).request(
      '/v1/episode-summaries?limit=5&cursor=episode-9',
    );

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ limit: 5, cursor: 'episode-9' });
  });

  it('rejects an out-of-range limit', async () => {
    const { log, list } = createLog();
    const res = await createApp(log).request('/v1/episode-summaries?limit=0');

    expect(res.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns 500 when the store fails', async () => {
    const { log, list } = createLog();
    list.mockRejectedValueOnce(new Error('store failed'));
    expect(listEpisodeSummariesRoute.responses[500]).toBeDefined();
    const res = await createApp(log).request('/v1/episode-summaries');

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal_error' });
  });

  it('appears in the OpenAPI document', () => {
    const { log } = createLog();
    const document = createApp(log).getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
    });

    expect(document.paths['/v1/episode-summaries']?.get).toBeDefined();
  });

  it('returns 503 when the extension is not running', async () => {
    const { log } = createLog(false);
    const res = await createApp(log).request('/v1/episode-summaries');

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_running' });
  });
});
