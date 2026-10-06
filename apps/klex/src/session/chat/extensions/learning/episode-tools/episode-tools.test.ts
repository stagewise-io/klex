import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';

import { createEpisodeInvestigation } from './episode-tools';

function fixture() {
  const controller = new AbortController();
  const readPage = vi.fn<EpisodeFeed['readPage']>(async (id, options) => ({
    id,
    text: 'x'.repeat(options.limit),
    offset: options.offset,
    nextOffset: options.offset + options.limit,
    scannedBytes: options.maxBytes,
    truncated: true,
    startedAt: 'a',
    endedAt: 'b',
  }));
  const search = vi.fn<EpisodeFeed['search']>(async (query, options) => ({
    matches: Array.from({ length: options.limit }, (_, i) => ({
      id: `found-${i}`,
      snippet: query,
      offset: 0,
    })),
    scannedBytes: options.maxBytes,
    nextOffset: 1,
    truncated: true,
  }));
  const feed: EpisodeFeed = {
    isAvailable: () => true,
    subscribe: () => () => undefined,
    listCompleted: async () => [],
    listLatestCompleted: async () => [],
    listNeighbors: async () => [],
    compareIds: (a, b) => a.localeCompare(b),
    read: async () => null,
    readPage,
    search,
  };
  const investigation = createEpisodeInvestigation(
    feed,
    controller.signal,
    'primary',
  );
  const execute = (name: string, input: object) => {
    // These three local tools all execute object inputs and return plain objects.
    const tool = investigation.tools[name] as Tool<object, unknown> | undefined;
    return tool?.execute?.(input, {
      context: undefined,
      toolCallId: name,
      messages: [],
      abortSignal: controller.signal,
    });
  };
  return { controller, readPage, search, investigation, execute };
}

describe('episode investigation', () => {
  it('exposes only read-only tools and treats listings as no evidence', async () => {
    const { investigation, execute } = fixture();
    expect(Object.keys(investigation.tools).sort()).toEqual([
      'listEpisodeNeighbors',
      'readEpisode',
      'searchEpisodes',
    ]);
    expect(
      await execute('listEpisodeNeighbors', { id: 'primary', count: 5 }),
    ).toEqual({ episodes: [] });
    expect([...investigation.evidence]).toEqual(['primary']);
  });
  it('reserves budgets before parallel reads and limits distinct evidence', async () => {
    const { execute, readPage, investigation } = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        execute('readEpisode', { id: `extra-${i}`, offset: 0, limit: 12_000 }),
      ),
    );
    expect(readPage).toHaveBeenCalledTimes(5);
    expect(
      results.filter(
        (result) =>
          result &&
          typeof result === 'object' &&
          'status' in result &&
          result.status === 'budget-exhausted',
      ),
    ).toHaveLength(3);
    expect(investigation.evidence.size).toBe(6);
    expect(
      readPage.mock.calls.reduce((n, [, options]) => n + options.limit, 0),
    ).toBe(60_000);
    expect(
      readPage.mock.calls.reduce((n, [, options]) => n + options.maxBytes, 0),
    ).toBeLessThanOrEqual(2_000_000);
  });
  it('shares the call budget across same-episode pages and reuse', async () => {
    const { execute, readPage, investigation } = fixture();
    for (let i = 0; i < 8; i++)
      await execute('readEpisode', {
        id: 'primary',
        offset: i * 100,
        limit: 100,
      });
    expect(
      await execute('readEpisode', { id: 'primary', offset: 800, limit: 100 }),
    ).toEqual({ status: 'budget-exhausted' });
    expect(readPage).toHaveBeenCalledTimes(8);
    expect([...investigation.evidence]).toEqual(['primary']);
  });
  it('counts snippets as evidence and returns partial search metadata', async () => {
    const { execute, search, investigation } = fixture();
    expect(
      await execute('searchEpisodes', { query: 'fix', offset: 0 }),
    ).toMatchObject({ status: 'ok', truncated: true, nextOffset: 1 });
    expect(search).toHaveBeenCalledTimes(1);
    expect(investigation.evidence.size).toBe(7);
    expect(
      await execute('readEpisode', { id: 'seventh', offset: 0, limit: 100 }),
    ).toEqual({ status: 'budget-exhausted' });
  });
  it('does not charge the primary episode as an additional search result', async () => {
    const { execute, search, readPage, investigation } = fixture();
    search.mockResolvedValueOnce({
      matches: [{ id: 'primary', snippet: 'fix', offset: 0 }],
      scannedBytes: 10,
      nextOffset: null,
      truncated: false,
    });
    readPage.mockImplementation(async (id) => ({
      id,
      text: 'evidence',
      offset: 0,
      nextOffset: null,
      scannedBytes: 10,
      truncated: false,
      startedAt: 'a',
      endedAt: 'b',
    }));
    await execute('searchEpisodes', { query: 'fix', offset: 0 });
    for (let index = 0; index < 6; index++)
      expect(
        await execute('readEpisode', {
          id: `extra-${index}`,
          offset: 0,
          limit: 100,
        }),
      ).toMatchObject({ status: 'ok' });
    expect(readPage).toHaveBeenCalledTimes(6);
    expect(investigation.evidence.size).toBe(7);
    expect(
      await execute('readEpisode', { id: 'seventh', offset: 0, limit: 100 }),
    ).toEqual({ status: 'budget-exhausted' });
  });

  it('does not expose evidence after cancellation or invoke more I/O', async () => {
    const { controller, execute, readPage, investigation } = fixture();
    readPage.mockImplementationOnce(async () => {
      controller.abort();
      return {
        id: 'late',
        text: 'late',
        offset: 0,
        nextOffset: null,
        scannedBytes: 4,
        truncated: false,
        startedAt: 'a',
        endedAt: 'b',
      };
    });
    expect(
      await execute('readEpisode', { id: 'late', offset: 0, limit: 100 }),
    ).toEqual({ status: 'cancelled' });
    expect(investigation.evidence.has('late')).toBe(false);
    expect(
      await execute('readEpisode', { id: 'later', offset: 0, limit: 100 }),
    ).toEqual({ status: 'cancelled' });
    expect(readPage).toHaveBeenCalledTimes(1);
  });
});
