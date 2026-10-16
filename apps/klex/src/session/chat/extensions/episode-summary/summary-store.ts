import { type Client, createClient } from '@libsql/client';

import {
  initializeSqliteStore,
  inspectSqliteStore,
  migrateSqliteStore,
  type SqliteStoreDefinition,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

export const EPISODE_SUMMARY_STORE_DEFINITION: SqliteStoreDefinition = {
  kind: 'sqlite',
  id: 'episode-summaries',
  relativePath: 'extensions/io.stagewise/episode-summary/summaries.sqlite',
  required: false,
  createIfMissing: true,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.16.2',
  initSql: `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS summaries (
      episode_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('titled', 'skipped')),
      title TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model_id TEXT
    );
    CREATE INDEX IF NOT EXISTS summaries_listing
      ON summaries (status, started_at DESC, episode_id DESC);
    CREATE TABLE IF NOT EXISTS summary_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  migrations: [],
  validate: async (client) => {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tableNames = new Set(
      tables.rows.flatMap((row) =>
        typeof row.name === 'string' ? [row.name] : [],
      ),
    );
    for (const table of ['summaries', 'summary_state']) {
      if (!tableNames.has(table))
        throw new Error(`Episode summary store is missing table: ${table}`);
    }
    const columns = await client.execute("PRAGMA table_info('summaries')");
    const required = new Set([
      'episode_id',
      'status',
      'title',
      'started_at',
      'ended_at',
      'created_at',
      'model_id',
    ]);
    for (const row of columns.rows) {
      if (typeof row.name === 'string') required.delete(row.name);
    }
    if (required.size > 0) {
      throw new Error(
        `Episode summary store is missing columns: ${[...required].join(', ')}`,
      );
    }
    const integrity = await client.execute('PRAGMA quick_check');
    if (integrity.rows[0]?.quick_check !== 'ok')
      throw new Error('Episode summary store failed SQLite integrity check');
  },
};

export type SummaryStatus = 'titled' | 'skipped';

export interface SummaryRow {
  episodeId: string;
  status: SummaryStatus;
  title: string | null;
  startedAt: string;
  endedAt: string;
  createdAt: string;
  modelId: string | null;
}

export interface StoredSummary {
  episodeId: string;
  title: string;
  startedAt: string;
  endedAt: string;
  createdAt: string;
}

export interface StoredSummaryPage {
  items: StoredSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SummaryCursor {
  initialized: boolean;
  episodeId: string | null;
}

/** Persisted summaries plus the episode cursor, in one SQLite file. */
export interface SummaryStore {
  start(): Promise<void>;
  getCursor(): Promise<SummaryCursor>;
  initializeCursor(episodeId: string | null): Promise<void>;
  /** Inserts the row (ignored if present) and advances the cursor atomically. */
  commit(row: SummaryRow): Promise<void>;
  list(options: { limit: number; cursor?: string }): Promise<StoredSummaryPage>;
  close(): Promise<void>;
}

const CURSOR_KEY = 'cursor';
const INITIALIZED_KEY = 'cursor_initialized';

class SummaryStoreModule implements SummaryStore {
  private client: Client | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly dataDirectory: string,
  ) {}

  start(): Promise<void> {
    this.starting ??= this.open();
    return this.starting;
  }

  async getCursor(): Promise<SummaryCursor> {
    const result = await this.requireClient().execute({
      sql: 'SELECT key, value FROM summary_state WHERE key IN (?, ?)',
      args: [CURSOR_KEY, INITIALIZED_KEY],
    });
    const values = new Map<string, string>();
    for (const row of result.rows) {
      if (typeof row.key === 'string' && typeof row.value === 'string')
        values.set(row.key, row.value);
    }
    return {
      initialized: values.get(INITIALIZED_KEY) === 'true',
      episodeId: values.get(CURSOR_KEY) ?? null,
    };
  }

  async initializeCursor(episodeId: string | null): Promise<void> {
    const statements = [
      {
        sql: 'INSERT INTO summary_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [INITIALIZED_KEY, 'true'],
      },
      episodeId === null
        ? {
            sql: 'DELETE FROM summary_state WHERE key = ?',
            args: [CURSOR_KEY],
          }
        : {
            sql: 'INSERT INTO summary_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            args: [CURSOR_KEY, episodeId],
          },
    ];
    await this.requireClient().batch(statements, 'write');
  }

  async commit(row: SummaryRow): Promise<void> {
    await this.requireClient().batch(
      [
        {
          sql: `INSERT OR IGNORE INTO summaries
            (episode_id, status, title, started_at, ended_at, created_at, model_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            row.episodeId,
            row.status,
            row.title,
            row.startedAt,
            row.endedAt,
            row.createdAt,
            row.modelId,
          ],
        },
        {
          sql: 'INSERT INTO summary_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          args: [CURSOR_KEY, row.episodeId],
        },
      ],
      'write',
    );
  }

  async list(options: {
    limit: number;
    cursor?: string;
  }): Promise<StoredSummaryPage> {
    const limit = Math.max(1, Math.floor(options.limit));
    const client = this.requireClient();
    const result = options.cursor
      ? await client.execute({
          sql: `SELECT episode_id, title, started_at, ended_at, created_at
            FROM summaries
            WHERE status = 'titled'
              AND (started_at, episode_id) < (
                SELECT started_at, episode_id FROM summaries WHERE episode_id = ?
              )
            ORDER BY started_at DESC, episode_id DESC
            LIMIT ?`,
          args: [options.cursor, limit + 1],
        })
      : await client.execute({
          sql: `SELECT episode_id, title, started_at, ended_at, created_at
            FROM summaries
            WHERE status = 'titled'
            ORDER BY started_at DESC, episode_id DESC
            LIMIT ?`,
          args: [limit + 1],
        });
    const items = result.rows.slice(0, limit).map((row) => ({
      episodeId: String(row.episode_id),
      title: String(row.title ?? ''),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      createdAt: String(row.created_at),
    }));
    const hasMore = result.rows.length > limit;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.episodeId ?? null) : null,
      hasMore,
    };
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.client?.close();
    this.client = null;
  }

  private async open(): Promise<void> {
    // Local-data startup normally creates the store. Repeat the check so a
    // missing or older file never reaches the queries below; unlike a cache,
    // summaries are not rebuilt, so every error propagates.
    const inspection = await inspectSqliteStore(
      this.databasePath,
      EPISODE_SUMMARY_STORE_DEFINITION,
      this.dataDirectory,
    );
    if (!inspection) {
      await initializeSqliteStore(
        this.databasePath,
        EPISODE_SUMMARY_STORE_DEFINITION,
        KLEX_VERSION,
      );
    } else {
      await migrateSqliteStore(
        this.databasePath,
        EPISODE_SUMMARY_STORE_DEFINITION,
        inspection.metadata,
        KLEX_VERSION,
        inspection.legacy,
      );
    }
    this.client = createClient({ url: `file:${this.databasePath}` });
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('Episode summary store is not started');
    return this.client;
  }
}

/**
 * Opens the summary store at `databasePath`. `dataDirectory` is the agent
 * data directory, used for compatibility diagnostics.
 */
export function createSummaryStore(
  databasePath: string,
  dataDirectory: string,
): SummaryStore {
  return new SummaryStoreModule(databasePath, dataDirectory);
}
