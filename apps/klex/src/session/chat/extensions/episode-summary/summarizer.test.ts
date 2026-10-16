import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  CompletedEpisode,
  EpisodeFeed,
} from '@/session/chat/extensions/memory';

import type { GenerateTextArgs, GenerateTextResult } from '../extension-api';
import {
  buildEpisodeInput,
  createSummarizer,
  MAX_INPUT_CHARACTERS,
  MAX_OUTPUT_TOKENS,
  parseTitle,
  type Summarizer,
} from './summarizer';
import type {
  StoredSummaryPage,
  SummaryCursor,
  SummaryRow,
  SummaryStore,
} from './summary-store';

vi.mock('./summary-prompt.md', () => ({ default: 'Title the episode.' }));

function episode(id: string, recordCount = 3): CompletedEpisode {
  return {
    id,
    date: '2026-10-01',
    index: Number(id.replace(/\D/gu, '')) || 0,
    startedAt: `2026-10-01T10:0${id.at(-1)}:00.000Z`,
    endedAt: `2026-10-01T10:0${id.at(-1)}:30.000Z`,
    recordCount,
    text: `text of ${id}`,
  };
}

function createFeed(initial: CompletedEpisode[]) {
  const episodes = [...initial];
  const missing = new Set<string>();
  const state = { available: true };
  const feed: EpisodeFeed = {
    isAvailable: () => state.available,
    subscribe: () => () => undefined,
    listNeighbors: async () => [],
    readPage: async () => null,
    search: async () => ({
      matches: [],
      nextOffset: null,
      scannedBytes: 0,
      truncated: false,
    }),
    listCompleted: async (after, limit) =>
      episodes
        .filter((item) => after === null || item.id > after)
        .slice(0, limit),
    listLatestCompleted: async (count) => episodes.slice(-count).reverse(),
    read: async (id) =>
      missing.has(id)
        ? null
        : (episodes.find((item) => item.id === id) ?? null),
    compareIds: (left, right) => left.localeCompare(right),
  };
  return { feed, episodes, missing, state };
}

function createStore(initialized = true, episodeId: string | null = null) {
  const rows = new Map<string, SummaryRow>();
  let cursor: SummaryCursor = { initialized, episodeId };
  const store: SummaryStore = {
    start: async () => undefined,
    getCursor: async () => ({ ...cursor }),
    initializeCursor: async (id) => {
      cursor = { initialized: true, episodeId: id };
    },
    commit: async (row) => {
      if (!rows.has(row.episodeId)) rows.set(row.episodeId, row);
      cursor = { initialized: true, episodeId: row.episodeId };
    },
    list: async (): Promise<StoredSummaryPage> => ({
      items: [],
      nextCursor: null,
      hasMore: false,
    }),
    close: async () => undefined,
  };
  return { store, rows, cursor: () => cursor };
}

type Success = Extract<GenerateTextResult, { success: true }>;

function success(
  text: string,
  finishReason: Success['finishReason'] = 'stop',
): GenerateTextResult {
  return {
    success: true,
    text,
    modelId: 'test:model',
    usage: {} as Success['usage'],
    finishReason,
  };
}

const MODEL = { providerId: 'test', modelId: 'model' };

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ModuleLogger;

function setup(options: {
  episodes: CompletedEpisode[];
  initialized?: boolean;
  cursor?: string | null;
  generateText?: (args: GenerateTextArgs) => Promise<GenerateTextResult>;
}) {
  const feed = createFeed(options.episodes);
  const store = createStore(
    options.initialized ?? true,
    options.cursor ?? null,
  );
  const generateText = vi.fn(
    options.generateText ??
      (async (args: GenerateTextArgs) => success(`Handled ${args.prompt}`)),
  );
  const summarizer = createSummarizer({
    episodes: feed.feed,
    store: store.store,
    generateText,
    getModelIds: () => [MODEL],
    logger,
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  });
  summarizer.start();
  return { feed, store, generateText, summarizer };
}

async function settle(summarizer: Summarizer): Promise<void> {
  await vi.waitFor(() => {
    expect(summarizer.introspect().running).toBe(false);
  });
}

describe('parseTitle', () => {
  it('normalizes quotes, bullets, prefixes and trailing periods', () => {
    expect(parseTitle('\n- "Fixed the deploy script."\nextra')).toBe(
      'Fixed the deploy script',
    );
    expect(parseTitle('Title: Planned the offsite')).toBe(
      'Planned the offsite',
    );
  });

  it('returns null for SKIP and empty output', () => {
    expect(parseTitle(' skip ')).toBeNull();
    expect(parseTitle('\n\n')).toBeNull();
  });

  it('caps words and characters', () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(parseTitle(long)?.split(' ')).toHaveLength(12);
    expect(parseTitle('x'.repeat(300))?.length).toBe(100);
  });
});

describe('buildEpisodeInput', () => {
  it('keeps short text and trims long text to the budget', () => {
    expect(buildEpisodeInput('short')).toBe('short');
    const long = `HEAD${'a'.repeat(30_000)}TAIL`;
    const input = buildEpisodeInput(long);
    expect(input.length).toBe(MAX_INPUT_CHARACTERS);
    expect(input.startsWith('HEAD')).toBe(true);
    expect(input.endsWith('TAIL')).toBe(true);
    expect(input).toContain('middle omitted');
  });
});

describe('summarizer', () => {
  it('initializes the cursor at the latest episode without model calls', async () => {
    const { store, generateText, summarizer } = setup({
      episodes: [episode('e1'), episode('e2')],
      initialized: false,
    });

    summarizer.wake();
    await settle(summarizer);

    expect(store.cursor()).toEqual({ initialized: true, episodeId: 'e2' });
    expect(generateText).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('defers cursor initialization while the feed is unavailable', async () => {
    const { feed, store, summarizer } = setup({
      episodes: [episode('e1')],
      initialized: false,
    });
    feed.state.available = false;

    summarizer.wake();
    await settle(summarizer);
    expect(store.cursor()).toEqual({ initialized: false, episodeId: null });

    feed.state.available = true;
    summarizer.wake();
    await settle(summarizer);
    expect(store.cursor()).toEqual({ initialized: true, episodeId: 'e1' });
  });

  it('titles new episodes in order and skips trivial ones without a call', async () => {
    const { feed, store, generateText, summarizer } = setup({
      episodes: [episode('e1'), episode('e2', 1), episode('e3'), episode('e4')],
      generateText: async (args) =>
        success(args.prompt?.includes('e3') ? 'SKIP' : `Did ${args.prompt}`),
    });
    feed.missing.add('e4');

    summarizer.wake();
    await settle(summarizer);

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      modelIds: [MODEL],
      prompt: 'text of e1',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    expect(generateText.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
    expect(Object.fromEntries(store.rows)).toMatchObject({
      e1: { status: 'titled', title: 'Did text of e1', modelId: 'test:model' },
      e2: { status: 'skipped', title: null, modelId: null },
      e3: { status: 'skipped', title: null, modelId: 'test:model' },
      e4: {
        status: 'skipped',
        startedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(store.cursor().episodeId).toBe('e4');

    // A second wake with nothing new is a no-op.
    summarizer.wake();
    await settle(summarizer);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('keeps the cursor on model failure and retries on the next wake', async () => {
    let fail = true;
    const { store, generateText, summarizer } = setup({
      episodes: [episode('e1'), episode('e2')],
      generateText: async (args) =>
        fail
          ? { success: false, failureReason: 'all-models-failed' }
          : success(`Did ${args.prompt}`),
    });

    summarizer.wake();
    await settle(summarizer);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(store.cursor().episodeId).toBeNull();
    expect(summarizer.introspect().lastError).toBe('all-models-failed');

    fail = false;
    summarizer.wake();
    await settle(summarizer);
    expect([...store.rows.keys()]).toEqual(['e1', 'e2']);
    expect(summarizer.introspect().lastError).toBeNull();
  });

  it.each([
    ['truncated', success('Confirmed PR', 'length')],
    ['empty', success('  \n')],
  ])(
    'keeps the cursor on %s output and retries on the next wake',
    async (_, first) => {
      let calls = 0;
      const { store, summarizer } = setup({
        episodes: [episode('e1')],
        generateText: async () =>
          calls++ === 0 ? first : success('Confirmed PR #231 preview'),
      });

      summarizer.wake();
      await settle(summarizer);
      expect(store.rows.size).toBe(0);
      expect(store.cursor().episodeId).toBeNull();
      expect(summarizer.introspect().lastError).toMatch(/^incomplete output/u);

      summarizer.wake();
      await settle(summarizer);
      expect(store.rows.get('e1')).toMatchObject({
        status: 'titled',
        title: 'Confirmed PR #231 preview',
      });
    },
  );

  it('reruns once when woken during a pass', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { feed, store, summarizer } = setup({
      episodes: [episode('e1')],
      generateText: async (args) => {
        await gate;
        return success(`Did ${args.prompt}`);
      },
    });

    summarizer.wake();
    feed.episodes.push(episode('e2'));
    summarizer.wake();
    expect(summarizer.introspect().dirty).toBe(true);
    release();
    await settle(summarizer);

    expect([...store.rows.keys()]).toEqual(['e1', 'e2']);
  });

  it('aborts in-flight generation on close without committing', async () => {
    const { store, generateText, summarizer } = setup({
      episodes: [episode('e1')],
      generateText: (args) =>
        new Promise((resolve) => {
          args.abortSignal?.addEventListener('abort', () =>
            resolve({ success: false, failureReason: 'cancelled' }),
          );
        }),
    });

    summarizer.wake();
    await vi.waitFor(() => {
      expect(generateText).toHaveBeenCalled();
    });
    await summarizer.close();

    expect(store.rows.size).toBe(0);
    expect(store.cursor().episodeId).toBeNull();
    summarizer.wake();
    expect(summarizer.introspect().running).toBe(false);
  });

  it('logs and stops the pass when the store throws', async () => {
    const { store, summarizer } = setup({ episodes: [episode('e1')] });
    store.store.commit = async () => {
      throw new Error('disk full');
    };

    summarizer.wake();
    await settle(summarizer);

    expect(summarizer.introspect().lastError).toBe('disk full');
  });
});
