import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createEpisodeFeed } from '@/session/chat/extensions/memory/episodes/episode-feed';

import { getEpisodeTrace, getEpisodeTraceRoute } from './episode-trace';
import { setupTestApp } from './test-utils';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const episodeId = '2026-10-16/1-12-00.jsonl';
const at = '2026-10-16T12:00:00.000Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'episode-trace-'));
  roots.push(root);
  await mkdir(join(root, '2026-10-16'));
  const records = Array.from({ length: 3 }, (_, index) => ({
    kind: 'record',
    v: 1,
    at,
    messageId: `message-${index}`,
    role: 'assistant',
    record: { kind: 'text', text: `Step ${index}` },
  }));
  await writeFile(
    join(root, episodeId),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  const feed = createEpisodeFeed();
  let open = false;
  feed.attach({
    episodicDir: root,
    getOpenEpisode: async () =>
      open
        ? {
            path: join(root, episodeId),
            characters: 100,
            createdAt: 0,
            lastActivityAt: 0,
          }
        : null,
  });
  const app = setupTestApp((app) =>
    app.openapi(getEpisodeTraceRoute, getEpisodeTrace({ episodeFeed: feed })),
  );
  return {
    root,
    records,
    app,
    setOpen: () => {
      open = true;
    },
  };
}
function url(id = episodeId) {
  return `/v1/episode-summaries/trace?episodeId=${encodeURIComponent(id)}`;
}

test('pages the exact archived episode backward, even when records share timestamps', async () => {
  const { app, root, records } = await fixture();
  await writeFile(
    join(root, '2026-10-16/2-12-00.jsonl'),
    JSON.stringify({
      ...records[0],
      record: { kind: 'text', text: 'Another episode' },
    }),
  );
  const latest = await app.request(`${url()}&limit=2`);
  expect(latest.status).toBe(200);
  expect(await latest.json()).toEqual({
    records: [
      { ...records[1], index: 1 },
      { ...records[2], index: 2 },
    ],
    nextCursor: 1,
    hasMore: true,
  });
  const earlier = await app.request(`${url()}&limit=2&cursor=1`);
  expect(await earlier.json()).toEqual({
    records: [{ ...records[0], index: 0 }],
    nextCursor: null,
    hasMore: false,
  });
  expect(await (await app.request(`${url()}&cursor=0`)).json()).toMatchObject({
    records: [],
    hasMore: false,
  });
});

test('rejects traversal, invalid cursors, missing episodes, and the open episode', async () => {
  const { app, setOpen } = await fixture();
  expect((await app.request(url('../../config.json'))).status).toBe(400);
  expect((await app.request(`${url()}&cursor=-1`)).status).toBe(400);
  expect((await app.request(url('2026-10-16/9-12-00.jsonl'))).status).toBe(404);
  setOpen();
  expect((await app.request(url())).status).toBe(404);
});

test('rejects symlink episodes and reports unavailable memory', async () => {
  const { root, app } = await fixture();
  await symlink(join(root, episodeId), join(root, '2026-10-16/2-12-00.jsonl'));
  expect((await app.request(url('2026-10-16/2-12-00.jsonl'))).status).toBe(404);
  const unavailable = setupTestApp((app) =>
    app.openapi(
      getEpisodeTraceRoute,
      getEpisodeTrace({ episodeFeed: createEpisodeFeed() }),
    ),
  );
  expect((await unavailable.request(url())).status).toBe(503);
});
