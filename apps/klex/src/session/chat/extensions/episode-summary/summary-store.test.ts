import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeSqliteStore, inspectSqliteStore } from '@/local-data';

import {
  createSummaryStore,
  EPISODE_SUMMARY_STORE_DEFINITION,
  type SummaryRow,
  type SummaryStore,
} from './summary-store';

const directories: string[] = [];
const stores: SummaryStore[] = [];

async function fixturePath(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-episode-summary-'));
  directories.push(directory);
  return { directory, file: join(directory, 'summaries.sqlite') };
}

async function openStore(file: string, directory: string) {
  const store = createSummaryStore(file, directory);
  stores.push(store);
  await store.start();
  return store;
}

function row(
  episodeId: string,
  startedAt: string,
  overrides: Partial<SummaryRow> = {},
): SummaryRow {
  return {
    episodeId,
    status: 'titled',
    title: `Did ${episodeId}`,
    startedAt,
    endedAt: startedAt,
    createdAt: '2026-10-03T00:00:00.000Z',
    modelId: 'test:model',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('episode summary store', () => {
  it('initializes a fresh file with an uninitialized cursor', async () => {
    const { directory, file } = await fixturePath();
    const store = await openStore(file, directory);

    expect(await store.getCursor()).toEqual({
      initialized: false,
      episodeId: null,
    });
    expect(await store.list({ limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(
      await inspectSqliteStore(
        file,
        EPISODE_SUMMARY_STORE_DEFINITION,
        directory,
      ),
    ).toMatchObject({ legacy: false, metadata: { schemaVersion: 1 } });
  });

  it('commits idempotently and advances the cursor', async () => {
    const { directory, file } = await fixturePath();
    const store = await openStore(file, directory);
    await store.initializeCursor(null);

    const first = row('a', '2026-10-01T10:00:00.000Z');
    await store.commit(first);
    await store.commit({ ...first, title: 'Overwritten' });

    const page = await store.list({ limit: 10 });
    expect(page.items).toEqual([
      {
        episodeId: 'a',
        title: 'Did a',
        startedAt: first.startedAt,
        endedAt: first.endedAt,
        createdAt: first.createdAt,
      },
    ]);
    expect(await store.getCursor()).toEqual({
      initialized: true,
      episodeId: 'a',
    });
  });

  it('persists the cursor across reopen', async () => {
    const { directory, file } = await fixturePath();
    const first = await openStore(file, directory);
    await first.initializeCursor('episode-7');
    await first.close();

    const reopened = await openStore(file, directory);
    expect(await reopened.getCursor()).toEqual({
      initialized: true,
      episodeId: 'episode-7',
    });
  });

  it('excludes skipped rows and pages newest first by keyset', async () => {
    const { directory, file } = await fixturePath();
    const store = await openStore(file, directory);
    await store.commit(row('a', '2026-10-01T10:00:00.000Z'));
    await store.commit(row('b', '2026-10-01T11:00:00.000Z'));
    await store.commit(
      row('c', '2026-10-01T12:00:00.000Z', { status: 'skipped', title: null }),
    );
    await store.commit(row('d', '2026-10-01T12:00:00.000Z'));
    await store.commit(row('e', '2026-10-01T13:00:00.000Z'));

    const first = await store.list({ limit: 2 });
    expect(first.items.map((item) => item.episodeId)).toEqual(['e', 'd']);
    expect(first).toMatchObject({ nextCursor: 'd', hasMore: true });

    const second = await store.list({ limit: 2, cursor: 'd' });
    expect(second.items.map((item) => item.episodeId)).toEqual(['b', 'a']);
    expect(second).toMatchObject({ nextCursor: null, hasMore: false });

    // A skipped row still works as a cursor anchor.
    const fromSkipped = await store.list({ limit: 10, cursor: 'c' });
    expect(fromSkipped.items.map((item) => item.episodeId)).toEqual(['b', 'a']);

    expect(await store.list({ limit: 10, cursor: 'missing' })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('rejects a newer schema without mutating it', async () => {
    const { directory, file } = await fixturePath();
    await initializeSqliteStore(
      file,
      EPISODE_SUMMARY_STORE_DEFINITION,
      '0.16.2',
    );
    const client = createClient({ url: `file:${file}` });
    await client.execute({
      sql: 'UPDATE meta SET value = ? WHERE key = ?',
      args: ['2', 'schemaVersion'],
    });
    client.close();

    const store = createSummaryStore(file, directory);
    stores.push(store);
    await expect(store.start()).rejects.toThrow(/schema=2/u);

    const verification = createClient({ url: `file:${file}` });
    const result = await verification.execute({
      sql: 'SELECT value FROM meta WHERE key = ?',
      args: ['schemaVersion'],
    });
    verification.close();
    expect(result.rows[0]?.value).toBe('2');
  });
});
