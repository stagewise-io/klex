import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActivityFixture } from '@/activity-history/test-support';

import { ActivityEntryStore } from './activity-reader';
import {
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  EpisodicSearchIndex,
} from './search-index';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(texts: string[] = []) {
  const fixture = await createActivityFixture([
    EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  ]);
  cleanup.push(() => fixture.close());
  for (const text of texts) await fixture.append(text);
  const database = join(
    fixture.directory,
    EPISODIC_SEARCH_INDEX_STORE_DEFINITION.relativePath,
  );
  const store = new ActivityEntryStore(fixture.activities);
  const index = new EpisodicSearchIndex(database, store);
  cleanup.push(() => index.close());
  await index.start();
  return { ...fixture, database, store, index };
}

describe('canonical activity search index', () => {
  it('supports SQLite FTS5, bounded snippets and owned context handles', async () => {
    const { index } = await setup(['I completed the billing migration review']);
    const hits = await index.search('billing migration', 5, 'owner');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('billing');
    expect(await index.readHandles([hits[0]!.handle], 0, 0, 'other')).toEqual(
      [],
    );
    expect(
      await index.readHandles([hits[0]!.handle], 0, 0, 'owner'),
    ).toHaveLength(1);
    index.clearOwner('owner');
    expect(await index.readHandles([hits[0]!.handle], 0, 0, 'owner')).toEqual(
      [],
    );
  });

  it('normalizes casing, stems terms, preserves phrases, and bounds fuzzy candidates', async () => {
    const { index } = await setup([
      'Alice reviewed Project-X migrations, carefully.',
    ]);
    expect(await index.search('MIGRATE', 5)).toHaveLength(1);
    expect(await index.search('"Project-X migrations"', 5)).toHaveLength(1);
    const candidates = await index.fuzzyCandidates('migraton', 2);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(2);
    expect(await index.search('"[bad FTS syntax"', 5)).toEqual([]);
  });

  it('matches quoted phrases containing n as phrases', async () => {
    const { index } = await setup([
      'I finished the billing migration',
      'The migration moved billing exports',
    ]);
    expect(await index.search('billing migration', 5)).toHaveLength(2);
    const hits = await index.search('"billing migration"', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scoreBand).toBe('strong');
  });

  it('expands typos, transpositions and compound spelling without unrelated terms', async () => {
    const { index } = await setup([
      'I finished the billing migration for Project-X',
      'I sent the billing invoice',
      'Mango delivery arrived',
    ]);
    const typo = await index.expandQuery('migraton, billing', {
      onlyUnknown: true,
    });
    expect(typo.expandedTerms).toEqual(['migration']);
    expect((await index.search(typo.query, 5))[0]?.snippet).toContain(
      'migration',
    );
    expect(await index.fuzzyCandidates('bilnig', 4)).toContain('billing');
    expect(await index.fuzzyCandidates('projectx', 4)).toContain('project-x');
    expect(await index.fuzzyCandidates('project_x', 4)).toContain('project-x');
    expect(await index.fuzzyCandidates('mangrove', 4)).not.toContain(
      'migration',
    );
    expect(await index.fuzzyCandidates('ab', 4)).toEqual([]);
  });

  it('reconciles canonical append, same-size repair, rollback and restart', async () => {
    const { index, database, store, append, sync } = await setup([
      'original phrase',
    ]);
    await append('appended phrase');
    await index.reconcile();
    expect(await index.search('appended', 5)).toHaveLength(1);
    await sync([
      {
        id: 'repaired',
        role: 'assistant',
        parts: [{ type: 'text', text: 'manually edited phrase' }],
      },
    ]);
    await index.reconcile();
    expect(await index.search('original', 5)).toEqual([]);
    expect(await index.search('manually', 5)).toHaveLength(1);
    await sync([]);
    await index.reconcile();
    expect(await index.search('manually', 5)).toEqual([]);
    expect(index.getStatus()).toBe('ready');
    await index.close();
    const restarted = new EpisodicSearchIndex(database, store);
    cleanup.push(() => restarted.close());
    await restarted.start();
    expect(await restarted.search('manually', 5)).toEqual([]);
  });

  it('never exposes cached text after deletion, even before reconciliation', async () => {
    const { index, sync } = await setup(['secret revoked evidence']);
    const [hit] = await index.search('revoked', 5);
    await sync([]);
    expect(await index.search('revoked', 5)).toEqual([]);
    expect(await index.readHandles([hit!.handle], 1, 1)).toEqual([]);
  });

  it('finds any line and reads chronological neighbors across source messages', async () => {
    const { index, append } = await setup([
      'older context',
      'chatId: C123\nquarterly invoice ready',
      'newer context',
    ]);
    const [hit] = await index.search('quarterly invoice', 5);
    const entries = await index.readHandles([hit!.handle], 1, 1);
    expect(entries).toHaveLength(3);
    expect(entries[1]?.text).toContain('¦quarterly invoice ready');
    expect(entries[0]?.text).toContain('older context');
    expect(entries[2]?.text).toContain('newer context');
    await append('raw user secret', 'user');
    await index.reconcile();
    expect(await index.search('raw user secret', 5)).toEqual([]);
  });

  it('reconciles 1,000 sources without rereading unchanged bodies and drops revoked evidence', async () => {
    const { index, store, sync } = await setup();
    const messages = Array.from({ length: 1_000 }, (_, number) => ({
      id: `scale-${number}`,
      role: 'assistant' as const,
      parts: [
        {
          type: 'text' as const,
          text: `Retained search evidence number ${number}. ${number >= 900 ? 'revocable-marker' : 'stable-marker'}`,
        },
      ],
    }));
    await sync(messages);
    const buildStart = performance.now();
    await index.reconcile();
    const buildMs = performance.now() - buildStart;
    expect(await index.search('revocable-marker', 5)).toHaveLength(5);
    const reads = vi.spyOn(store, 'read');
    const warmStart = performance.now();
    await index.reconcile();
    const warmMs = performance.now() - warmStart;
    expect(reads).not.toHaveBeenCalled();
    await sync(messages.slice(0, 900));
    await index.reconcile();
    expect(await index.search('revocable-marker', 5)).toEqual([]);
    expect(await index.search('stable-marker', 5)).toHaveLength(5);
    console.info('search scale (1,000 sources)', { buildMs, warmMs });
  }, 30_000);

  it('keeps ambiguous temporal words as terms', async () => {
    const { index } = await setup([
      'Their last name is Lee',
      'Yesterday the billing migration completed',
    ]);
    expect(await index.search('last name', 5)).toHaveLength(1);
    expect(await index.search('yesterday billing', 5)).toHaveLength(1);
  });
});
