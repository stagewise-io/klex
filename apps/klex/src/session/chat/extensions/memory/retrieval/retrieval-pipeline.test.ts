import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActivityFixture } from '@/activity-history/test-support';
import type {
  Extension,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';

import { ActivityEntryStore } from './activity-reader';
import { DEFAULT_MEMORY_RETRIEVAL_CONFIG } from './retrieval';
import { createRetrievalToolsExt } from './retrieval-tools';
import {
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  EpisodicSearchIndex,
} from './search-index';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const call = { toolCallId: 't', messages: [] } as never;
interface SearchResult {
  hits: { handle: string; snippet: string; occurredAt: string }[];
}

/** Canonical transcript, derived index, and actual retrieval tool dispatch. */
async function pipeline() {
  const fixture = await createActivityFixture([
    EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  ]);
  cleanup.push(() => fixture.close());
  fixture.setTime('2026-10-01T14:03:00Z');
  const index = new EpisodicSearchIndex(
    join(
      fixture.directory,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION.relativePath,
    ),
    new ActivityEntryStore(fixture.activities),
  );
  cleanup.push(() => index.close());
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
    return selected.execute(
      (selected.inputSchema as { parse(v: unknown): unknown }).parse(
        args,
      ) as never,
      call,
    );
  };
  return {
    ...fixture,
    index,
    turn: async <T>(body: () => Promise<T>): Promise<T> => {
      extension.onStepStart?.();
      try {
        return await body();
      } finally {
        extension.onStepComplete?.({
          shouldContinue: false,
          fatalError: false,
        } as StepCompleteEvent);
      }
    },
    search: (query: string) =>
      run('searchMemory', { query, mode: 'exact' }) as Promise<SearchResult>,
    read: (handles: string[]) =>
      run('readMemoryContext', { handles }) as Promise<{ text: string }>,
  };
}

describe('retrieval over canonical SQLite history', () => {
  it('searches filtered context and reads structured tool/output records', async () => {
    const { sync, turn, search, read } = await pipeline();
    await sync([
      {
        id: 'u1',
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'slack',
              metadata: { from: 'U42' },
              content: [
                { type: 'text', text: 'Can you ship the invoice export?' },
              ],
            },
          } as never,
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'send',
            toolName: 'sendMessage',
            state: 'output-available',
            input: { chatId: 'C123' },
            output: 'sent',
          },
          { type: 'text', text: 'Shipped the invoice export to Dana.' },
        ],
      },
    ]);
    const { hits, text } = await turn(async () => {
      const result = await search('invoice export');
      return {
        hits: result.hits,
        text: (await read(result.hits.map((hit) => hit.handle))).text,
      };
    });
    expect(hits).toHaveLength(2);
    expect(
      hits.every((hit) => hit.occurredAt === '2026-10-01T14:03:00.000Z'),
    ).toBe(true);
    expect(text).toContain('context slack');
    expect(text).toContain('¦Can you ship the invoice export?');
    expect(text).toContain('your_action sendMessage succeeded');
    expect(text).toContain('C123');
    expect(text).toContain('Shipped the invoice export to Dana.');
  });

  it('picks up canonical commits after an earlier child turn', async () => {
    const { append, setTime, turn, search } = await pipeline();
    await append('Kicked off the billing review.');
    expect((await turn(() => search('billing'))).hits).toHaveLength(1);
    setTime('2026-10-01T14:04:00Z');
    await append('Finished the billing review with Omar.');
    const { hits } = await turn(() => search('Omar'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('Omar');
  });

  it('never searches inactive JSONL or markdown archives', async () => {
    const { directory, append, turn, search } = await pipeline();
    const archive = join(directory, 'episodic', '2026-10-01');
    await mkdir(archive, { recursive: true });
    await writeFile(
      join(archive, '1-09-00.jsonl'),
      '{"kind":"record","text":"legacy walruses"}',
    );
    await writeFile(join(archive, '2-09-00.md'), 'legacy walruses');
    expect((await turn(() => search('walruses'))).hits).toHaveLength(0);
    await append('Canonical entry about walruses.');
    const { hits } = await turn(() => search('walruses'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('Canonical');
  });

  it('rejects stale handles after a same-size repair and reconciles the next turn', async () => {
    const { sync, turn, search, read } = await pipeline();
    const message = (text: string) => ({
      id: 'repair',
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text }],
    });
    await sync([message('violet customer evidence')]);
    await turn(async () => {
      const { hits } = await search('violet');
      expect(hits).toHaveLength(1);
      await sync([message('orange customer evidence')]);
      expect((await read(hits.map((hit) => hit.handle))).text).not.toContain(
        'violet customer evidence',
      );
    });
    expect((await turn(() => search('violet'))).hits).toHaveLength(0);
    const repaired = await turn(async () => {
      const { hits } = await search('orange');
      expect(hits).toHaveLength(1);
      return read(hits.map((hit) => hit.handle));
    });
    expect(repaired.text).toContain('orange customer evidence');
  });

  it('rejects stale evidence after rollback between search and context reads', async () => {
    const { append, sync, turn, search, read } = await pipeline();
    await append('revoked customer evidence');
    await turn(async () => {
      const { hits } = await search('revoked');
      expect(hits).toHaveLength(1);
      await sync([]);
      expect((await read(hits.map((hit) => hit.handle))).text).not.toContain(
        'customer evidence',
      );
    });
  });
});
