import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEpisodeFeed } from './episode-feed';
import type { EpisodeStoreState } from './episode-files';
import { episodeFile, HEADER_LINE, output, recordLine } from './test-utils';

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
    getOpenEpisode: async () => open,
  });
  return { feed, detach };
}

describe('episode feed', () => {
  it('pages rendered text exactly and bounds reads and searches', async () => {
    const id = '2026-10-06/1-12-00.jsonl';
    const { feed } = attached(
      await episodicDir({ [id]: file('hello '.repeat(8_000)) }),
    );
    const full = await feed.read(id);
    const first = await feed.readPage(id, {
      offset: 0,
      limit: 12_000,
      maxBytes: 100_000,
    });
    const second = await feed.readPage(id, {
      offset: first?.nextOffset ?? 0,
      limit: 12_000,
      maxBytes: 100_000,
    });
    expect(first?.text).toBe(full?.text.slice(0, 12_000));
    expect(second?.text).toBe(full?.text.slice(12_000, 24_000));
    const tiny = await feed.readPage(id, {
      offset: 0,
      limit: 100,
      maxBytes: 20,
    });
    expect(tiny).toMatchObject({
      text: '',
      scannedBytes: 20,
      truncated: true,
      nextOffset: null,
    });
    const search = await feed.search('HELLO', {
      offset: 0,
      maxBytes: 100_000,
      limit: 1,
    });
    expect(search.matches[0]?.id).toBe(id);
    expect(search.scannedBytes).toBeLessThanOrEqual(100_000);
  });

  it('reads actual EOF within the tail scan budget and drops a partial leading record', async () => {
    const id = '2026-10-06/1-12-00.jsonl';
    const { feed } = attached(
      await episodicDir({
        [id]: `${file('old '.repeat(1_000))}${file('latest verified outcome '.repeat(20))}`,
      }),
    );
    const page = await feed.readPage(id, {
      offset: 0,
      limit: 1_000,
      maxBytes: 1_000,
      tail: true,
    });
    expect(page?.text).toContain('latest verified outcome');
    expect(page?.text).not.toContain('old ');
    expect(page).toMatchObject({
      scannedBytes: 1_000,
      truncated: true,
      nextOffset: null,
    });
  });

  it.each([true, false])(
    'preserves a complete record at the exact tail boundary, trailing newline: %s',
    async (trailingNewline) => {
      const id = '2026-10-06/1-12-00.jsonl';
      const serialized = recordLine(
        output('latest verified outcome 🧠 '.repeat(20)),
        at,
      );
      const tail = trailingNewline ? serialized : serialized.slice(0, -1);
      const maxBytes = Buffer.byteLength(tail);
      const { feed } = attached(
        await episodicDir({ [id]: `${file('older evidence')}${tail}` }),
      );
      const page = await feed.readPage(id, {
        offset: 0,
        limit: 1_000,
        maxBytes,
        tail: true,
      });
      expect(page?.text).toContain('latest verified outcome 🧠');
      expect(page?.text).not.toContain('older evidence');
      expect(page).toMatchObject({
        startedAt: at,
        endedAt: at,
        scannedBytes: maxBytes,
        truncated: true,
        nextOffset: null,
      });
    },
  );

  it('preserves a complete record exactly filling the two-megabyte tail budget', async () => {
    const id = '2026-10-06/1-12-00.jsonl';
    const text = 'verified resolution';
    const maxBytes = 2_000_000;
    const padding = maxBytes - Buffer.byteLength(recordLine(output(text), at));
    const tail = recordLine(output(`${'x'.repeat(padding)}${text}`), at);
    expect(Buffer.byteLength(tail)).toBe(maxBytes);
    const { feed } = attached(
      await episodicDir({ [id]: `${file('older evidence')}${tail}` }),
    );
    const page = await feed.readPage(id, {
      offset: 0,
      limit: 1_000,
      maxBytes,
      tail: true,
    });
    expect(page?.text.endsWith(text)).toBe(true);
    expect(page).toMatchObject({
      scannedBytes: maxBytes,
      truncated: true,
      nextOffset: null,
    });
  });

  it('reports unvisited episodes as a partial search even when the byte budget remains', async () => {
    const { feed } = attached(
      await episodicDir({
        '2026-10-06/1-12-00.jsonl': file('older outcome'),
        '2026-10-06/2-12-00.jsonl': file('newer outcome'),
      }),
    );
    const first = await feed.search('outcome', {
      offset: 0,
      maxBytes: 10_000,
      limit: 1,
    });
    expect(first).toMatchObject({ truncated: true, nextOffset: 1 });
    expect(first.scannedBytes).toBeLessThan(10_000);
    const last = await feed.search('outcome', {
      offset: 1,
      maxBytes: 10_000,
      limit: 1,
    });
    expect(last).toMatchObject({ truncated: false, nextOffset: null });
  });

  it('returns no neighbors for zero, negative or non-finite counts', async () => {
    const id = '2026-10-06/2-12-00.jsonl';
    const { feed } = attached(
      await episodicDir({
        '2026-10-06/1-12-00.jsonl': file('before'),
        [id]: file('current'),
        '2026-10-06/3-12-00.jsonl': file('after'),
      }),
    );
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await feed.listNeighbors(id, count)).toEqual([]);
  });

  it('refuses symlinked files and date directories and never returns active pages', async () => {
    const id = '2026-10-06/1-12-00.jsonl';
    const outside = await episodicDir({ [id]: file('secret') });
    const dir = await episodicDir({});
    await mkdir(join(dir, '2026-10-06'));
    await symlink(join(outside, id), join(dir, id));
    const { feed } = attached(dir);
    expect(
      await feed.readPage(id, { offset: 0, limit: 100, maxBytes: 1_000 }),
    ).toBeNull();
    await rm(join(dir, '2026-10-06'), { recursive: true });
    await symlink(join(outside, '2026-10-06'), join(dir, '2026-10-06'));
    expect(
      await feed.readPage(id, { offset: 0, limit: 100, maxBytes: 1_000 }),
    ).toBeNull();
    const active = attached(outside, id).feed;
    expect(
      await active.readPage(id, { offset: 0, limit: 100, maxBytes: 1_000 }),
    ).toBeNull();
    expect(
      await active.readPage('../secret', {
        offset: 0,
        limit: 100,
        maxBytes: 1_000,
      }),
    ).toBeNull();
  });

  it('lists numeric neighbours and skips incomplete oversized JSONL records', async () => {
    const id = '2026-10-06/10-12-00.jsonl';
    const { feed } = attached(
      await episodicDir({
        '2026-10-06/9-12-00.jsonl': file('before'),
        [id]: file('x'.repeat(3_000_000)),
        '2026-10-06/11-12-00.jsonl': file('after'),
      }),
    );
    expect((await feed.listNeighbors(id, 1)).map((ref) => ref.index)).toEqual([
      9, 11,
    ]);
    const page = await feed.readPage(id, {
      offset: 0,
      limit: 100,
      maxBytes: 1_000,
    });
    expect(page).toMatchObject({
      text: '',
      scannedBytes: 1_000,
      truncated: true,
    });
  });
  it('notifies subscriptions on attachment, coalesces hints, and detaches safely', async () => {
    const feed = createEpisodeFeed();
    const listener = vi.fn();
    const unsubscribe = feed.subscribe(listener);
    const detach = feed.attach({
      episodicDir: await episodicDir({}),
      getOpenEpisode: async () => null,
    });
    feed.notifyChanged();
    feed.notifyChanged();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    detach();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    feed.notifyChanged();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not let a failing subscriber suppress another subscriber', async () => {
    const feed = createEpisodeFeed();
    feed.subscribe(() => {
      throw new Error('subscriber');
    });
    const listener = vi.fn();
    feed.subscribe(listener);
    feed.notifyChanged();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
  });
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
    expect(await feed.read('2026-10-06/2-00-20.jsonl')).toBeNull();
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
      feed.attach({ episodicDir: dir, getOpenEpisode: async () => null }),
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
