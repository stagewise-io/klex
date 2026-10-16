import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';

import type { ExtensionDeps } from '../extension-api';
import { createEpisodeSummaryExt } from './episode-summary';
import { createEpisodeSummaryLog } from './summary-log';

vi.mock('./summary-prompt.md', () => ({ default: 'Title the episode.' }));

/** Memory not ready: the summarizer idles, which keeps these tests model-free. */
function createEpisodeFeed(): EpisodeFeed & { listeners: number } {
  const feed = {
    listeners: 0,
    isAvailable: () => false,
    subscribe: () => {
      feed.listeners += 1;
      return () => {
        feed.listeners -= 1;
      };
    },
    listNeighbors: async () => [],
    readPage: async () => null,
    search: async () => ({
      matches: [],
      nextOffset: null,
      scannedBytes: 0,
      truncated: false,
    }),
    listCompleted: async () => [],
    listLatestCompleted: async () => [],
    read: async () => null,
    compareIds: (left: string, right: string) => left.localeCompare(right),
  };
  return feed;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-episode-summary-ext-'));
  directories.push(directory);
  return directory;
}

function fakeDeps(dataDir: string, sessionId: string) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const deps = {
    sessionId,
    getDataDir: () => dataDir,
    logger,
    logging: { child: () => logger },
    config: { getModelSelection: () => ['test/model'] },
    generateText: vi.fn(),
  } as unknown as ExtensionDeps;
  return { deps, logger };
}

describe('episode summary extension', () => {
  it('lets only the first default session own the summarizer and log', async () => {
    const dataDir = await dataDirectory();
    const episodes = createEpisodeFeed();
    const summaryLog = createEpisodeSummaryLog();
    const factory = createEpisodeSummaryExt({ episodes, summaryLog });

    const background = factory.create(fakeDeps(dataDir, 'background-1').deps);
    await background.onStart?.();
    expect(summaryLog.isAvailable()).toBe(false);

    const owner = factory.create(fakeDeps(dataDir, DEFAULT_SESSION_ID).deps);
    await owner.onStart?.();
    expect(summaryLog.isAvailable()).toBe(true);
    expect(episodes.listeners).toBe(1);
    expect(await summaryLog.list({ limit: 5 })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });

    const second = factory.create(fakeDeps(dataDir, DEFAULT_SESSION_ID).deps);
    await second.onStart?.();
    expect(second.introspect?.()).toMatchObject({
      summarizer: 'not owned by this session',
    });
    await second.onClose?.();
    expect(summaryLog.isAvailable()).toBe(true);

    await owner.onClose?.();
    expect(summaryLog.isAvailable()).toBe(false);
    expect(episodes.listeners).toBe(0);
    await background.onClose?.();

    // The claim is released, so a new default session can take over.
    const successor = factory.create(
      fakeDeps(dataDir, DEFAULT_SESSION_ID).deps,
    );
    await successor.onStart?.();
    expect(summaryLog.isAvailable()).toBe(true);
    await successor.onClose?.();
  });

  it('keeps the log unavailable when the store cannot start', async () => {
    const dataDir = await dataDirectory();
    await writeFile(join(dataDir, 'summaries.sqlite'), 'not a database');
    const episodes = createEpisodeFeed();
    const summaryLog = createEpisodeSummaryLog();
    const factory = createEpisodeSummaryExt({ episodes, summaryLog });
    const { deps, logger } = fakeDeps(dataDir, DEFAULT_SESSION_ID);

    const owner = factory.create(deps);
    await expect(owner.onStart?.()).resolves.toBeUndefined();

    expect(summaryLog.isAvailable()).toBe(false);
    expect(episodes.listeners).toBe(0);
    expect(logger.error).toHaveBeenCalledOnce();
    await owner.onClose?.();
  });
});
