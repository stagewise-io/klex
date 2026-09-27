import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initializeSqliteStore } from '@/local-data';

import { episodeFile, input, output, recordLine } from '../episodes/test-utils';
import { EpisodicEntryStore } from './episode-reader';
import {
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  EpisodicSearchIndex,
} from './search-index';

const AT = '2026-01-01T10:00:00.000Z';
const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function prepareIndex(
  root: string,
  store: EpisodicEntryStore,
): Promise<{ database: string; index: EpisodicSearchIndex }> {
  const database = join(root, 'index.sqlite');
  await initializeSqliteStore(
    database,
    EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
    '0.9.2',
  );
  return { database, index: new EpisodicSearchIndex(database, store) };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('episodic search index', () => {
  it('supports packaged SQLite FTS5 search and snippets', async () => {
    const root = await temporaryDirectory('klex-search-');
    await mkdir(join(root, '2026-01-01'));
    await writeFile(
      join(root, '2026-01-01', '1-10-00.jsonl'),
      episodeFile(AT, output('I completed the billing migration review')),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();
    const hits = await index.search('billing migration', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('billing');
    expect(await index.readHandles([hits[0]!.handle], 0, 0)).toHaveLength(1);
    await index.close();
  });

  it('normalizes casing, stems terms, preserves phrases, and bounds fuzzy candidates', async () => {
    const root = await temporaryDirectory('klex-search-query-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    await writeFile(
      join(dateDir, '1-10-00.jsonl'),
      episodeFile(
        AT,
        output('Alice reviewed Project-X migrations, carefully.'),
      ),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();
    expect(await index.search('MIGRATE', 5)).toHaveLength(1);
    expect(await index.search('"Project-X migrations"', 5)).toHaveLength(1);
    const candidates = await index.fuzzyCandidates('migraton', 2);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(2);
    expect(await index.search('"[bad FTS syntax"', 5)).toEqual([]);
    await index.close();
  });

  it('matches quoted phrases containing the letter n as phrases', async () => {
    const root = await temporaryDirectory('klex-search-phrase-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    await writeFile(
      join(dateDir, '1-10-00.jsonl'),
      episodeFile(
        AT,
        output('I finished the billing migration'),
        output('The migration moved billing exports'),
      ),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();
    expect(await index.search('billing migration', 5)).toHaveLength(2);
    const hits = await index.search('"billing migration"', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scoreBand).toBe('strong');
    await index.close();
  });

  it('finds differently written episodes through fuzzy expansion', async () => {
    const root = await temporaryDirectory('klex-search-fuzzy-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    await writeFile(
      join(dateDir, '1-10-00.jsonl'),
      episodeFile(
        AT,
        output('I finished the billing migration for Project-X'),
        output('I sent the billing invoice'),
        output('Mango delivery arrived'),
      ),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();

    // Typo next to a correctly spelled term: only the unknown term expands.
    const typo = await index.expandQuery('migraton, billing', {
      onlyUnknown: true,
    });
    expect(typo.expandedTerms).toEqual(['migration']);
    const [top] = await index.search(typo.query, 5);
    expect(top?.snippet).toContain('migration');

    // Transposition and compound spelling variants.
    expect(await index.fuzzyCandidates('bilnig', 4)).toContain('billing');
    expect(await index.fuzzyCandidates('projectx', 4)).toContain('project-x');
    expect(await index.fuzzyCandidates('project_x', 4)).toContain('project-x');

    // Unrelated terms sharing trigrams are rejected.
    expect(await index.fuzzyCandidates('mangrove', 4)).not.toContain(
      'migration',
    );
    expect(await index.fuzzyCandidates('ab', 4)).toEqual([]);
    await index.close();
  });

  it('reconciles append, manual edit, deletion, and restart incrementally', async () => {
    const root = await temporaryDirectory('klex-search-reconcile-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    const file = join(dateDir, '1-10-00.jsonl');
    await writeFile(file, episodeFile(AT, output('original phrase')));
    const store = new EpisodicEntryStore(root);
    const { database, index } = await prepareIndex(root, store);
    await index.start();
    expect(await index.search('original', 5)).toHaveLength(1);

    await appendFile(file, recordLine(output('appended phrase'), AT));
    await index.reconcile();
    expect(await index.search('appended', 5)).toHaveLength(1);

    await writeFile(file, episodeFile(AT, output('manually edited phrase')));
    await index.reconcile();
    expect(await index.search('original', 5)).toHaveLength(0);
    expect(await index.search('manually', 5)).toHaveLength(1);

    await rm(file);
    await index.reconcile();
    expect(await index.search('manually', 5)).toHaveLength(0);
    expect(index.getState().status).toBe('ready');
    await index.close();

    const restarted = new EpisodicSearchIndex(database, store);
    await restarted.start();
    expect(await restarted.search('manually edited phrase', 5)).toHaveLength(0);
    await restarted.close();
  });

  it('finds terms on any line of a multi-line record', async () => {
    const root = await temporaryDirectory('klex-search-block-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    await writeFile(
      join(dateDir, '1-10-00.jsonl'),
      episodeFile(
        AT,
        output('chatId: C123\nquarterly invoice ready'),
        input(
          {
            kind: 'context',
            source: 'slack',
            metadata: 'from: U42',
            items: [],
          },
          { role: 'user' },
        ),
      ),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();
    const hits = await index.search('quarterly invoice', 5);
    expect(hits).toHaveLength(1);
    const [entry] = await index.readHandles([hits[0]!.handle], 0, 0);
    expect(entry?.text).toBe(
      'your_output\n¦chatId: C123\n¦quarterly invoice ready',
    );
    expect(await index.search('U42', 5)).toHaveLength(1);
    await index.close();
  });

  it('keeps ambiguous temporal words as search terms', async () => {
    const root = await temporaryDirectory('klex-search-recency-');
    const dateDir = join(root, '2026-01-01');
    await mkdir(dateDir);
    await writeFile(
      join(dateDir, '1-10-00.jsonl'),
      episodeFile(
        AT,
        output('Their last name is Lee'),
        output('Yesterday the billing migration completed'),
      ),
    );
    const store = new EpisodicEntryStore(root);
    const { index } = await prepareIndex(root, store);
    await index.start();
    expect(await index.search('last name', 5)).toHaveLength(1);
    expect(await index.search('yesterday billing', 5)).toHaveLength(1);
    await index.close();
  });
});
