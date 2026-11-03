import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActivityFixture } from '@/activity-history/test-support';

import { type ActivityEntry, ActivityEntryStore } from './activity-reader';
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

function inspect(database: string) {
  const client = createClient({ url: `file:${database}` });
  cleanup.push(async () => client.close());
  return client;
}

async function mutableSource() {
  const fixture = await setup(['migration original', 'sentinel']);
  const sources = await fixture.store.listSources();
  const source = sources[0]!;
  let entries = await fixture.store.read(source.id);
  const read = fixture.store.read.bind(fixture.store);
  vi.spyOn(fixture.store, 'listSources').mockImplementation(
    async () => sources,
  );
  vi.spyOn(fixture.store, 'read').mockImplementation(async (id) =>
    id === source.id ? entries : read(id),
  );
  return {
    ...fixture,
    client: inspect(fixture.database),
    sourceId: source.id,
    replace(texts: string[]) {
      entries = texts.map(
        (text, entryOrdinal): ActivityEntry => ({
          sourceId: source.id,
          entryOrdinal,
          occurredAt: source.persistedAt,
          text,
        }),
      );
      source.bytes = texts.join('').length;
      source.revision += '-changed';
    },
  };
}

describe('canonical activity search index', () => {
  it('preserves existing FTS rows on append and replaces rewritten or truncated entries', async () => {
    const { index, client, replace, sourceId } = await mutableSource();
    replace(['migration original']);
    await index.reconcile();
    await client.execute(
      "UPDATE activity_entries SET rowid = 100 WHERE text LIKE '%sentinel%'",
    );
    const rows = () =>
      client.execute({
        sql: 'SELECT rowid, text FROM activity_entries WHERE source_id = ? ORDER BY entry_ordinal',
        args: [sourceId],
      });
    const original = (await rows()).rows[0];
    replace(['migration original', 'migration appended']);
    await index.reconcile();
    expect((await rows()).rows[0]).toEqual(original);
    expect(await index.search('original', 5)).toHaveLength(1);
    expect(await index.search('appended', 5)).toHaveLength(1);
    expect(await index.fuzzyCandidates('migraton')).toContain('migration');
    expect(await index.fuzzyCandidates('appendd')).toContain('appended');
    expect(
      (
        await client.execute(
          "SELECT frequency FROM activity_vocabulary WHERE term = 'migration'",
        )
      ).rows[0]?.frequency,
    ).toBe(2);
    expect(
      (
        await client.execute(
          "SELECT frequency FROM activity_source_terms WHERE term = 'migration'",
        )
      ).rows[0]?.frequency,
    ).toBe(2);
    replace(['migration revised', 'migration appended']);
    await index.reconcile();
    expect(await index.search('original', 5)).toEqual([]);
    expect(await index.search('revised', 5)).toHaveLength(1);
    replace(['replacement']);
    await index.reconcile();
    expect(await index.search('appended', 5)).toEqual([]);
    expect((await rows()).rows).toHaveLength(1);
    for (const table of ['activity_vocabulary', 'activity_term_trigrams']) {
      expect(
        (
          await client.execute(
            `SELECT * FROM ${table} WHERE term IN ('migration', 'original', 'appended', 'revised')`,
          )
        ).rows,
      ).toEqual([]);
    }
  });

  it('keeps snapshots consistent after a failed append transaction and retries all entries', async () => {
    const { index, client, replace, store, sourceId } = await mutableSource();
    replace(['migration']);
    await index.reconcile();
    const sources = await store.listSources();
    const sentinel = sources.find((source) => source.id !== sourceId)!;
    sentinel.revision += '-changed';
    const read = vi.mocked(store.read).getMockImplementation()!;
    vi.spyOn(store, 'read').mockImplementation(async (id) => {
      if (id === sentinel.id) throw new Error('injected failure');
      return read(id);
    });
    replace(['migration', 'blocked']);
    await expect(index.reconcile()).rejects.toThrow('injected failure');
    expect(index.getStatus()).toBe('partial');
    expect(
      (
        await client.execute(
          "SELECT * FROM activity_entries WHERE text = 'blocked'",
        )
      ).rows,
    ).toEqual([]);
    vi.spyOn(store, 'read').mockImplementation(read);
    await index.reconcile();
    expect(await index.search('blocked', 5)).toHaveLength(1);
    expect(
      (
        await client.execute(
          "SELECT term, frequency FROM activity_vocabulary WHERE term IN ('migration', 'blocked') ORDER BY term",
        )
      ).rows,
    ).toEqual([
      { term: 'blocked', frequency: 1 },
      { term: 'migration', frequency: 1 },
    ]);
  });

  it.each(['edit', 'delete'] as const)(
    'preserves shared vocabulary and removes exclusive terms after source %s',
    async (operation) => {
      const { index, database, sync } = await setup();
      const message = (id: string, text: string) => ({
        id,
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text }],
      });
      const retained = message('retained', 'migration retained');
      await sync([message('changed', 'migration exclusive'), retained]);
      await index.reconcile();
      const client = inspect(database);
      const trigrams = await client.execute(
        "SELECT trigram FROM activity_term_trigrams WHERE term = 'migration' ORDER BY trigram",
      );
      await sync(
        operation === 'edit'
          ? [message('changed', 'replacement'), retained]
          : [retained],
      );
      await index.reconcile();
      expect(await index.search('migration', 5)).toHaveLength(1);
      expect(await index.fuzzyCandidates('migraton')).toContain('migration');
      expect(await index.fuzzyCandidates('exclusiv')).not.toContain(
        'exclusive',
      );
      expect(
        (
          await client.execute(
            "SELECT frequency FROM activity_vocabulary WHERE term = 'migration'",
          )
        ).rows[0]?.frequency,
      ).toBe(1);
      expect(
        (
          await client.execute(
            "SELECT trigram FROM activity_term_trigrams WHERE term = 'migration' ORDER BY trigram",
          )
        ).rows,
      ).toEqual(trigrams.rows);
      for (const table of [
        'activity_vocabulary',
        'activity_term_trigrams',
        'activity_source_terms',
      ]) {
        expect(
          (
            await client.execute(
              `SELECT * FROM ${table} WHERE term = 'exclusive'`,
            )
          ).rows,
        ).toEqual([]);
      }
    },
  );

  it('batches large sources across entry, vocabulary and trigram boundaries', async () => {
    const { index, client, replace } = await mutableSource();
    const texts = Array.from(
      { length: 205 },
      (_, i) => `migration term${i} extra${i}`,
    );
    replace(texts);
    await index.reconcile();
    replace([...texts, 'migration appended']);
    await index.reconcile();
    expect(await index.search('term204', 5)).toHaveLength(1);
    expect(await index.search('appended', 5)).toHaveLength(1);
    expect(
      (
        await client.execute(
          "SELECT frequency FROM activity_vocabulary WHERE term = 'migration'",
        )
      ).rows[0]?.frequency,
    ).toBe(206);
    expect(
      (
        await client.execute(
          "SELECT COUNT(*) AS count FROM activity_source_terms WHERE term LIKE 'term%'",
        )
      ).rows[0]?.count,
    ).toBe(205);
  });

  it('adds missing secondary indexes at startup and safely reconciles changed sources after restart', async () => {
    const { index, client, replace, database } = await mutableSource();
    replace(['migration']);
    await index.reconcile();
    await index.close();
    await client.executeMultiple(
      'DROP INDEX activity_term_trigrams_term; DROP INDEX activity_source_terms_term;',
    );
    replace(['replacement']);
    await index.start();
    expect(await index.search('migration', 5)).toEqual([]);
    expect(await index.search('replacement', 5)).toHaveLength(1);
    const restartedClient = inspect(database);
    for (const table of ['activity_term_trigrams', 'activity_source_terms']) {
      expect(
        (await restartedClient.execute(`PRAGMA index_info('${table}_term')`))
          .rows,
      ).toMatchObject([{ name: 'term' }]);
    }
    expect(
      (
        await client.execute(
          "SELECT key, value FROM meta WHERE key IN ('schemaVersion', 'compatibilityVersion') ORDER BY key",
        )
      ).rows,
    ).toEqual([
      { key: 'compatibilityVersion', value: '2' },
      { key: 'schemaVersion', value: '2' },
    ]);
  });

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
