import { type Client, createClient } from '@libsql/client';

import type { SqliteStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

import type { ActivityEntry, ActivityEntryStore } from './activity-reader';

export type SearchIndexStatus = 'ready' | 'partial' | 'rebuilding';

export const EPISODIC_SEARCH_INDEX_STORE_DEFINITION: SqliteStoreDefinition = {
  kind: 'sqlite',
  id: 'episodic-search-index',
  relativePath: 'extensions/io.stagewise/memory/episodic-search.sqlite',
  required: false,
  createIfMissing: true,
  schemaVersion: 2,
  compatibilityVersion: 2,
  minimumKlexVersion: '0.29.0',
  initSql: `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_sources (
      source_id TEXT PRIMARY KEY,
      byte_size INTEGER NOT NULL,
      revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_vocabulary (
      term TEXT PRIMARY KEY,
      frequency INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_term_trigrams (
      trigram TEXT NOT NULL,
      term TEXT NOT NULL REFERENCES activity_vocabulary(term) ON DELETE CASCADE,
      PRIMARY KEY (trigram, term)
    );
    CREATE INDEX IF NOT EXISTS activity_term_trigrams_lookup
      ON activity_term_trigrams (trigram);
    CREATE TABLE IF NOT EXISTS activity_source_terms (
      source_id TEXT NOT NULL,
      term TEXT NOT NULL,
      frequency INTEGER NOT NULL,
      PRIMARY KEY (source_id, term)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS activity_entries USING fts5(
      text,
      normalized_text UNINDEXED,
      source_id UNINDEXED,
      entry_ordinal UNINDEXED,
      occurred_at UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `,
  migrations: LOCAL_DATA_MIGRATIONS['episodic-search-index'].migrations,
  validate: async (client) => {
    const columns = await client.execute(
      "PRAGMA table_info('activity_entries')",
    );
    const required = new Set([
      'text',
      'normalized_text',
      'source_id',
      'entry_ordinal',
      'occurred_at',
    ]);
    for (const row of columns.rows) {
      const name = stringValue(row.name);
      if (name) required.delete(name);
    }
    if (required.size > 0) {
      throw new Error(
        `Episodic search index is missing columns: ${[...required].join(', ')}`,
      );
    }
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tableNames = new Set(
      tables.rows.flatMap((row) => {
        const name = stringValue(row.name);
        return name ? [name] : [];
      }),
    );
    for (const table of [
      'activity_sources',
      'activity_vocabulary',
      'activity_term_trigrams',
      'activity_source_terms',
    ]) {
      if (!tableNames.has(table))
        throw new Error(`Episodic search index is missing table: ${table}`);
    }
    const integrity = await client.execute('PRAGMA quick_check');
    if (stringValue(integrity.rows[0]?.quick_check) !== 'ok')
      throw new Error('Episodic search index failed SQLite integrity check');
  },
};

export interface SearchHit {
  handle: string;
  occurredAt: string;
  snippet: string;
  scoreBand: 'strong' | 'medium' | 'weak';
}

interface IndexedRow {
  rowId: number;
  sourceId: string;
  entryOrdinal: number;
  occurredAt: string;
  text: string;
}

export class EpisodicSearchIndex {
  private client: Client | null = null;
  private status: SearchIndexStatus = 'partial';
  private lastReconciledAt: string | null = null;
  private readonly handles = new Map<string, IndexedRow>();
  private readonly handleOwners = new Map<string, string>();
  private handleCounter = 0;
  private reconcilePromise: Promise<void> | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly store: ActivityEntryStore,
  ) {}

  getStatus(): SearchIndexStatus {
    return this.status;
  }

  getState(): {
    status: SearchIndexStatus;
    lastReconciledAt: string | null;
  } {
    return {
      status: this.status,
      lastReconciledAt: this.lastReconciledAt,
    };
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.client = createClient({ url: `file:${this.databasePath}` });
    try {
      await this.reconcile();
    } catch (error) {
      this.client.close();
      this.client = null;
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileInternal().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async reconcileInternal(): Promise<void> {
    if (!this.client) throw new Error('Episodic search index is not started');
    this.status = 'rebuilding';
    try {
      const sources = await this.store.listSources();
      const existing = await this.client.execute(
        'SELECT source_id, byte_size, revision FROM activity_sources',
      );
      const existingSources = new Map(
        existing.rows.flatMap((row) => {
          const path = stringValue(row.source_id);
          const bytes = numberValue(row.byte_size);
          const revision = stringValue(row.revision);
          return path && bytes !== null && revision
            ? [[path, { bytes, revision }] as const]
            : [];
        }),
      );
      const currentSources = new Set(sources.map((source) => source.id));
      await this.client.execute('BEGIN');
      try {
        for (const oldSource of existingSources.keys()) {
          if (currentSources.has(oldSource)) continue;
          await this.removeSourceVocabulary(oldSource);
          await this.deleteSource(oldSource);
        }
        for (const source of sources) {
          const previous = existingSources.get(source.id);
          if (
            previous?.bytes === source.bytes &&
            previous.revision === source.revision
          )
            continue;
          await this.removeSourceVocabulary(source.id);
          await this.deleteSource(source.id);
          const entries = await this.store.read(source.id);
          await this.client.execute({
            sql: 'INSERT INTO activity_sources (source_id, byte_size, revision) VALUES (?, ?, ?)',
            args: [source.id, source.bytes, source.revision],
          });
          for (const entry of entries) await this.insert(entry);
          await this.indexVocabulary(source.id, entries);
        }
        await this.client.execute('COMMIT');
        this.status = 'ready';
        this.lastReconciledAt = new Date().toISOString();
      } catch (error) {
        await this.client.execute('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.status = 'partial';
      throw error;
    }
  }

  /**
   * Returns indexed terms that are spelling variants of `term`: typos,
   * transpositions, and compound variants such as `projectx` / `project-x`.
   * Candidates are pre-selected by trigram overlap and accepted only within a
   * length-scaled edit distance, so unrelated terms sharing a trigram are dropped.
   */
  async fuzzyCandidates(term: string, limit = 8): Promise<string[]> {
    if (!this.client) return [];
    const normalized = tokenizeTerms(term)[0] ?? '';
    if (normalized.length < MIN_FUZZY_TERM_LENGTH) return [];
    const trigrams = [...new Set(trigramsFor(normalized))].slice(0, 32);
    if (trigrams.length === 0) return [];
    const placeholders = trigrams.map(() => '?').join(', ');
    const result = await this.client.execute({
      sql: `SELECT v.term, v.frequency, COUNT(*) AS overlap
        FROM activity_vocabulary v
        JOIN activity_term_trigrams t ON t.term = v.term
        WHERE t.trigram IN (${placeholders})
        GROUP BY v.term
        ORDER BY overlap DESC, v.frequency DESC
        LIMIT ?`,
      args: [...trigrams, FUZZY_PRESELECTION_LIMIT],
    });
    const compactQuery = compactTerm(normalized);
    const maxDistance = maxEditDistance(compactQuery.length);
    const scored = result.rows.flatMap((row) => {
      const candidate = stringValue(row.term);
      if (!candidate || candidate === normalized) return [];
      const compactCandidate = compactTerm(candidate);
      const distance = boundedEditDistance(
        compactQuery,
        compactCandidate,
        maxDistance,
      );
      const overlap = numberValue(row.overlap) ?? 0;
      const dice =
        (2 * overlap) /
        (trigrams.length + new Set(trigramsFor(candidate)).size);
      const compound =
        dice >= 0.5 &&
        Math.min(compactQuery.length, compactCandidate.length) >=
          MIN_FUZZY_TERM_LENGTH + 1 &&
        (compactCandidate.includes(compactQuery) ||
          compactQuery.includes(compactCandidate));
      if (distance > maxDistance && !compound) return [];
      return [
        {
          candidate,
          distance: Math.min(distance, maxDistance + 1),
          dice,
          frequency: numberValue(row.frequency) ?? 0,
        },
      ];
    });
    scored.sort(
      (a, b) =>
        a.distance - b.distance || b.dice - a.dice || b.frequency - a.frequency,
    );
    return scored
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(({ candidate }) => candidate);
  }

  /**
   * Adds spelling variants of query terms so differently written episodes are
   * still found. With `onlyUnknown`, only terms absent from the vocabulary are
   * expanded; otherwise every term is expanded.
   */
  async expandQuery(
    query: string,
    options: { onlyUnknown: boolean },
  ): Promise<{ query: string; expandedTerms: string[] }> {
    const expandedTerms: string[] = [];
    if (!this.client) return { query, expandedTerms };
    const terms = tokenizeTerms(stripRecencyTerms(query)).slice(
      0,
      MAX_FUZZY_QUERY_TERMS,
    );
    const seen = new Set(terms);
    for (const term of terms) {
      if (expandedTerms.length >= MAX_FUZZY_EXPANSIONS) break;
      if (options.onlyUnknown && (await this.hasTerm(term))) continue;
      for (const candidate of await this.fuzzyCandidates(
        term,
        FUZZY_CANDIDATES_PER_TERM,
      )) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        expandedTerms.push(candidate);
        if (expandedTerms.length >= MAX_FUZZY_EXPANSIONS) break;
      }
    }
    let expanded = query.slice(0, MAX_QUERY_CHARACTERS);
    const accepted: string[] = [];
    for (const term of expandedTerms) {
      if (expanded.length + term.length + 1 > MAX_QUERY_CHARACTERS) break;
      expanded = `${expanded} ${term}`;
      accepted.push(term);
    }
    return { query: expanded, expandedTerms: accepted };
  }

  private async hasTerm(term: string): Promise<boolean> {
    const result = await this.client?.execute({
      sql: 'SELECT 1 FROM activity_vocabulary WHERE term = ? LIMIT 1',
      args: [term],
    });
    return (result?.rows.length ?? 0) > 0;
  }

  async search(
    query: string,
    limit: number,
    owner = 'default',
  ): Promise<SearchHit[]> {
    const contentQuery = stripRecencyTerms(query);
    if (!this.client || !contentQuery) return [];
    const expression = ftsQuery(contentQuery);
    if (!expression) return [];
    const result = await this.client.execute({
      sql: `SELECT rowid, source_id, entry_ordinal, occurred_at, text,
        bm25(activity_entries) AS rank,
        snippet(activity_entries, 0, '[', ']', '…', 36) AS snippet
        FROM activity_entries
        WHERE activity_entries MATCH ?
        ORDER BY ${impliesRecency(query) ? 'occurred_at DESC, rank' : 'rank'}
        LIMIT ?`,
      args: [expression, Math.max(1, Math.min(limit, 20))],
    });
    const hits: SearchHit[] = [];
    for (const row of result.rows) {
      const rowId = numberValue(row.rowid);
      const sourceId = stringValue(row.source_id);
      const entryOrdinal = numberValue(row.entry_ordinal);
      const occurredAt = stringValue(row.occurred_at);
      const text = stringValue(row.text);
      const rank = numberValue(row.rank) ?? 0;
      if (rowId === null || !sourceId || entryOrdinal === null || !occurredAt)
        continue;
      // The index is disposable: repairs, retention and rollback may have
      // invalidated it since reconciliation. Never expose its stale text.
      const current = await this.store.read(sourceId);
      if (
        !current.some(
          (entry) => entry.entryOrdinal === entryOrdinal && entry.text === text,
        )
      )
        continue;
      const handle = `hit_${++this.handleCounter}`;
      this.handles.set(handle, {
        rowId,
        sourceId,
        entryOrdinal,
        occurredAt,
        text,
      });
      this.handleOwners.set(handle, owner);
      hits.push({
        handle,
        occurredAt,
        snippet: stringValue(row.snippet) || text.slice(0, 300),
        scoreBand: scoreBand(rank, query, text),
      });
    }
    return hits;
  }

  clearHandles(handles: readonly string[]): void {
    for (const handle of handles) {
      this.handles.delete(handle);
      this.handleOwners.delete(handle);
    }
  }

  clearOwner(owner: string): void {
    for (const [handle, handleOwner] of this.handleOwners) {
      if (handleOwner !== owner) continue;
      this.handleOwners.delete(handle);
      this.handles.delete(handle);
    }
  }

  async readHandles(
    handles: string[],
    before = 1,
    after = 1,
    owner = 'default',
  ): Promise<ActivityEntry[]> {
    const result: ActivityEntry[] = [];
    for (const handle of handles) {
      const row = this.handles.get(handle);
      if (!row || this.handleOwners.get(handle) !== owner) continue;
      const entries = await this.store.readNeighbors(
        {
          sourceId: row.sourceId,
          entryOrdinal: row.entryOrdinal,
          occurredAt: row.occurredAt,
          text: row.text,
        },
        before,
        after,
      );
      result.push(...entries);
    }
    return result;
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.handles.clear();
    this.handleOwners.clear();
  }

  private async indexVocabulary(
    sourceId: string,
    entries: readonly ActivityEntry[],
  ): Promise<void> {
    if (!this.client) return;
    const frequencies = new Map<string, number>();
    for (const entry of entries) {
      for (const term of tokenizeTerms(entry.text))
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    for (const [term, frequency] of frequencies) {
      await this.client.execute({
        sql: 'INSERT INTO activity_source_terms (source_id, term, frequency) VALUES (?, ?, ?)',
        args: [sourceId, term, frequency],
      });
      await this.client.execute({
        sql: `INSERT INTO activity_vocabulary (term, frequency) VALUES (?, ?)
          ON CONFLICT(term) DO UPDATE SET frequency = frequency + excluded.frequency`,
        args: [term, frequency],
      });
      for (const trigram of trigramsFor(term))
        await this.client.execute({
          sql: 'INSERT OR IGNORE INTO activity_term_trigrams (trigram, term) VALUES (?, ?)',
          args: [trigram, term],
        });
    }
  }

  private async removeSourceVocabulary(sourceId: string): Promise<void> {
    if (!this.client) return;
    const terms = await this.client.execute({
      sql: 'SELECT term, frequency FROM activity_source_terms WHERE source_id = ?',
      args: [sourceId],
    });
    for (const row of terms.rows) {
      const term = stringValue(row.term);
      const frequency = numberValue(row.frequency) ?? 0;
      if (!term) continue;
      await this.client.execute({
        sql: 'UPDATE activity_vocabulary SET frequency = frequency - ? WHERE term = ?',
        args: [frequency, term],
      });
      await this.client.execute({
        sql: 'DELETE FROM activity_term_trigrams WHERE term = ? AND NOT EXISTS (SELECT 1 FROM activity_source_terms WHERE term = ? AND source_id <> ?)',
        args: [term, term, sourceId],
      });
    }
    await this.client.execute({
      sql: 'DELETE FROM activity_vocabulary WHERE frequency <= 0',
    });
    await this.client.execute({
      sql: 'DELETE FROM activity_source_terms WHERE source_id = ?',
      args: [sourceId],
    });
  }

  private async deleteSource(sourceId: string): Promise<void> {
    await this.client?.execute({
      sql: 'DELETE FROM activity_entries WHERE source_id = ?',
      args: [sourceId],
    });
    await this.client?.execute({
      sql: 'DELETE FROM activity_sources WHERE source_id = ?',
      args: [sourceId],
    });
  }

  private async insert(entry: ActivityEntry): Promise<void> {
    await this.client?.execute({
      sql: 'INSERT INTO activity_entries (text, normalized_text, source_id, entry_ordinal, occurred_at) VALUES (?, ?, ?, ?, ?)',
      args: [
        entry.text,
        normalizeForSearch(entry.text),
        entry.sourceId,
        entry.entryOrdinal,
        entry.occurredAt,
      ],
    });
  }
}

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripRecencyTerms(query: string): string {
  return query.replace(/\b(?:latest|newest|most\s+recent)\b/giu, ' ').trim();
}

function ftsQuery(query: string): string {
  const expression = (value: string, joiner: ' OR ' | ' AND ') =>
    (value.match(/"[^"\n]*"|\S+/gu) ?? [])
      .map((token) => {
        const quoted = token.startsWith('"') && token.endsWith('"');
        const normalized = (quoted ? token.slice(1, -1) : token)
          .normalize('NFKC')
          .replace(/[^\p{L}\p{N}_-]/gu, ' ')
          .trim();
        return normalized ? `"${normalized.replaceAll('"', '""')}"` : '';
      })
      .filter(Boolean)
      .join(joiner);
  return expression(query, ' OR ');
}

function impliesRecency(query: string): boolean {
  return /\b(?:latest|newest|most\s+recent)\b/iu.test(query);
}

function scoreBand(
  rank: number,
  query: string,
  text: string,
): 'strong' | 'medium' | 'weak' {
  const phraseBoost = quotedPhrases(query).some((phrase) =>
    normalizeForSearch(text).includes(normalizeForSearch(phrase)),
  );
  if (phraseBoost || rank < -1.5) return 'strong';
  if (rank < -0.2) return 'medium';
  return 'weak';
}

function quotedPhrases(query: string): string[] {
  return [...query.matchAll(/"([^"\n]+)"/gu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

const MAX_INDEXED_TERM_LENGTH = 64;
const MAX_TERM_TRIGRAMS = 64;
const MAX_QUERY_CHARACTERS = 2_000;
const MIN_FUZZY_TERM_LENGTH = 3;
const MAX_FUZZY_QUERY_TERMS = 32;
const MAX_FUZZY_EXPANSIONS = 64;
const FUZZY_CANDIDATES_PER_TERM = 4;
const FUZZY_PRESELECTION_LIMIT = 64;

/** Hyphens and underscores are spelling noise for fuzzy comparison. */
function compactTerm(term: string): string {
  return term.replace(/[-_]/gu, '');
}

function maxEditDistance(length: number): number {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Optimal-string-alignment distance (Levenshtein plus adjacent transposition).
 * Returns `max + 1` as soon as the distance is known to exceed `max`.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, (previousPrevious[j - 2] ?? 0) + 1);
      current[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > max) return max + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

function tokenizeTerms(value: string): string[] {
  return (normalizeForSearch(value).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
    .map((term) => term.slice(0, MAX_INDEXED_TERM_LENGTH))
    .filter((term, index, terms) => terms.indexOf(term) === index);
}

function trigramsFor(value: string): string[] {
  const padded = `  ${value.slice(0, MAX_INDEXED_TERM_LENGTH)} `;
  return Array.from(
    { length: Math.min(MAX_TERM_TRIGRAMS, Math.max(0, padded.length - 2)) },
    (_, index) => padded.slice(index, index + 3),
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
