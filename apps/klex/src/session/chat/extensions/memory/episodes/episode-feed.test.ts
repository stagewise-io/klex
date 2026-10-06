import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEpisodeFeed } from './episode-feed';
import type { EpisodeStoreState } from './episode-files';
import { episodeFile, HEADER_LINE, output } from './test-utils';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function episodicDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'klex-episode-feed-'));
  directories.push(root);
  for (const [id, content] of Object.entries(files)) {
    await mkdir(join(root, id, '..'), { recursive: true });
    await writeFile(join(root, id), content, 'utf-8');
  }
  return root;
}

const at = '2026-10-06T12:00:00.000Z';
const file = (text: string) => episodeFile(at, output(text));

function attached(dir: string, openId: string | null = null) {
  const feed = createEpisodeFeed();
  const open: EpisodeStoreState | null = openId
    ? {
        path: join(dir, openId),
        characters: 1,
        createdAt: 0,
        lastActivityAt: 0,
      }
    : null;
  const detach = feed.attach({
    episodicDir: dir,
    getOpenEpisode: () => open,
  });
  return { feed, detach };
}

describe('episode feed', () => {
  it('orders by date and numeric index and reads strictly after the cursor', async () => {
    const dir = await episodicDir({
      '2026-10-05/10-23-00.jsonl': file('d1-10'),
      '2026-10-05/9-22-00.jsonl': file('d1-9'),
      '2026-10-06/1-00-10.jsonl': file('d2-1'),
      '2026-10-06/2-legacy.md': 'ignored',
    });
    const { feed } = attached(dir);
    const all = await feed.listCompleted(null, 10);
    expect(all.map((ref) => ref.id)).toEqual([
      '2026-10-05/9-22-00.jsonl',
      '2026-10-05/10-23-00.jsonl',
      '2026-10-06/1-00-10.jsonl',
    ]);
    const after = await feed.listCompleted('2026-10-05/9-22-00.jsonl', 1);
    expect(after.map((ref) => ref.id)).toEqual(['2026-10-05/10-23-00.jsonl']);
    expect((await feed.listLatestCompleted(2)).map((ref) => ref.id)).toEqual([
      '2026-10-05/10-23-00.jsonl',
      '2026-10-06/1-00-10.jsonl',
    ]);
  });

  it('excludes the open episode', async () => {
    const dir = await episodicDir({
      '2026-10-06/1-00-10.jsonl': file('closed'),
      '2026-10-06/2-00-20.jsonl': file('open'),
    });
    const { feed } = attached(dir, '2026-10-06/2-00-20.jsonl');
    expect((await feed.listCompleted(null, 10)).map((ref) => ref.id)).toEqual([
      '2026-10-06/1-00-10.jsonl',
    ]);
  });

  it('reads an episode and skips a truncated tail', async () => {
    const dir = await episodicDir({
      '2026-10-06/1-12-00.jsonl': `${file('hello')}{"v":1,"at":`,
    });
    const { feed } = attached(dir);
    const episode = await feed.read('2026-10-06/1-12-00.jsonl');
    expect(episode).toMatchObject({
      id: '2026-10-06/1-12-00.jsonl',
      date: '2026-10-06',
      index: 1,
      startedAt: at,
      endedAt: at,
      recordCount: 1,
    });
    expect(episode?.text).toContain('hello');
  });

  it('returns null for invalid ids, traversal, and header-only files', async () => {
    const dir = await episodicDir({ '2026-10-06/1-12-00.jsonl': HEADER_LINE });
    const { feed } = attached(dir);
    expect(await feed.read('../secret.jsonl')).toBeNull();
    expect(await feed.read('2026-10-06/../../x/1-00-00.jsonl')).toBeNull();
    expect(await feed.read('2026-10-06/1-12-00.jsonl')).toBeNull();
    expect(await feed.read('2026-10-06/7-12-00.jsonl')).toBeNull();
  });

  it('is empty and unavailable without a source', async () => {
    const dir = await episodicDir({ '2026-10-06/1-12-00.jsonl': file('x') });
    const { feed, detach } = attached(dir);
    expect(feed.isAvailable()).toBe(true);
    expect(() =>
      feed.attach({ episodicDir: dir, getOpenEpisode: () => null }),
    ).toThrow();
    detach();
    expect(feed.isAvailable()).toBe(false);
    expect(await feed.listCompleted(null, 10)).toEqual([]);
    expect(await feed.listLatestCompleted(5)).toEqual([]);
    expect(await feed.read('2026-10-06/1-12-00.jsonl')).toBeNull();
  });

  it('treats a missing episodic directory as empty', async () => {
    const dir = await episodicDir({});
    const { feed } = attached(join(dir, 'missing'));
    expect(await feed.listCompleted(null, 10)).toEqual([]);
  });
});
