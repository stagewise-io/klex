import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { initializeSqliteStore } from '@/local-data';
import type {
  Extension,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';

import { EpisodeStore } from '../episodes/episode-files';
import { input, output } from '../episodes/test-utils';
import { EpisodicEntryStore } from './episode-reader';
import { DEFAULT_MEMORY_RETRIEVAL_CONFIG } from './retrieval';
import { createRetrievalToolsExt } from './retrieval-tools';
import {
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  EpisodicSearchIndex,
} from './search-index';

const T0 = Date.parse('2026-01-02T14:03:00Z');
const directories: string[] = [];
const call = { toolCallId: 't', messages: [] } as never;
const finalStep = { shouldContinue: false, fatalError: false };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface SearchResult {
  hits: { handle: string; snippet: string; occurredAt: string }[];
}

/** Writer, index, and retrieval tools wired over one real directory. */
async function pipeline() {
  const root = await mkdtemp(join(tmpdir(), 'klex-retrieval-'));
  directories.push(root);
  const episodicDir = join(root, 'episodic');
  const writer = new EpisodeStore({
    episodicDir,
    getLimits: () => ({
      maxCharacters: 50_000,
      maxDurationMs: 3_600_000,
      idleTimeoutMs: 600_000,
    }),
    logger: { warn: vi.fn() } as unknown as ModuleLogger,
  });
  const database = join(root, 'index.sqlite');
  await initializeSqliteStore(
    database,
    EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
    '0.9.2',
  );
  const index = new EpisodicSearchIndex(
    database,
    new EpisodicEntryStore(episodicDir),
  );
  await index.start();
  const extension = createRetrievalToolsExt({
    index,
    retrieval: DEFAULT_MEMORY_RETRIEVAL_CONFIG,
    onSurface: vi.fn(),
  }).create({} as never) as Extension;
  const tools = extension.getTools?.({} as never) as ToolSet;
  const run = (name: string, args: Record<string, unknown>) => {
    const selected = tools[name];
    if (!selected?.execute) throw new Error(`${name} missing`);
    const parsed = (
      selected.inputSchema as { parse(v: unknown): unknown }
    ).parse(args);
    return selected.execute(parsed as never, call);
  };
  return {
    episodicDir,
    writer,
    index,
    /** Runs one child turn so the index reconciles once, like production. */
    turn: async <T>(body: () => Promise<T>): Promise<T> => {
      extension.onStepStart?.();
      try {
        return await body();
      } finally {
        extension.onStepComplete?.(finalStep as StepCompleteEvent);
      }
    },
    search: (query: string) =>
      run('searchMemory', { query, mode: 'exact' }) as Promise<SearchResult>,
    read: (handles: string[]) =>
      run('readMemoryContext', { handles }) as Promise<{ text: string }>,
  };
}

describe('retrieval over recorder-written JSONL episodes', () => {
  it('searches and reads records the episode store wrote', async () => {
    const { writer, index, turn, search, read } = await pipeline();
    await writer.append(
      [
        input(
          {
            kind: 'context',
            source: 'slack',
            metadata: 'from: U42',
            items: [{ kind: 'text', text: 'Can you ship the invoice export?' }],
          },
          { messageId: 'u1', role: 'user' },
        ),
        input(
          {
            kind: 'tool',
            name: 'sendMessage',
            status: 'succeeded',
            input: 'chatId: C123',
            output: 'sent',
          },
          { messageId: 'a1' },
        ),
        output('Shipped the invoice export to Dana.', 'a1'),
      ],
      T0,
    );

    const { hits, text } = await turn(async () => {
      const result = await search('invoice export');
      const handles = result.hits.map((hit) => hit.handle);
      return { hits: result.hits, text: (await read(handles)).text };
    });

    expect(hits).toHaveLength(2);
    expect(
      hits.every((hit) => hit.occurredAt === '2026-01-02T14:03:00.000Z'),
    ).toBe(true);
    expect(text).toContain('context slack');
    expect(text).toContain('¦Can you ship the invoice export?');
    expect(text).toContain('your_action sendMessage succeeded');
    expect(text).toContain('¦chatId: C123');
    expect(text).toContain(
      '2026-01-02T14:03:00.000Z: your_output\n¦Shipped the invoice export to Dana.',
    );
    expect(text).not.toMatch(/"kind"|\{"/);
    await index.close();
  });

  it('picks up records appended after an earlier turn', async () => {
    const { writer, index, turn, search } = await pipeline();
    await writer.append([output('Kicked off the billing review.')], T0);
    expect((await turn(() => search('billing'))).hits).toHaveLength(1);

    await writer.append(
      [output('Finished the billing review with Omar.', 'a2')],
      T0 + 60_000,
    );
    const { hits } = await turn(() => search('Omar'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('Omar');
    await index.close();
  });

  it('ignores legacy markdown episodes next to JSONL ones', async () => {
    const { episodicDir, writer, index, turn, search } = await pipeline();
    await writer.append([output('JSONL entry about walruses.')], T0);
    await writeFile(
      join(episodicDir, '2026-01-02', '9-09-00.md'),
      '---\nanalyzed: false\n---\n- 09:00: legacy walruses note\n',
    );
    const { hits } = await turn(() => search('walruses'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('JSONL');
    await index.close();
  });
});
