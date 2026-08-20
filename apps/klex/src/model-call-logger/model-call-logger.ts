import { type Client, createClient } from '@libsql/client';
import { and, asc, gte, lt } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { metaTable, migrateDatabase } from '@/utils/sqlite';

import {
  MODEL_CALL_INIT_SQL,
  MODEL_CALL_MIGRATIONS,
  MODEL_CALL_SCHEMA_VERSION,
  type ModelCallSchema,
  modelCallsTable,
} from './schema';
import type {
  ModelCallRecord,
  ModelCallSource,
  UsageDataPoint,
  UsageGranularity,
  UsageQuery,
  UsageSplitBy,
} from './types';

export interface ModelCallLoggerDependencies {
  logging: RootLogger;
  dataDirectory: string;
}

export interface ModelCallLogger {
  start(): Promise<void>;
  close(): Promise<void>;
  recordCall(record: ModelCallRecord): void;
  queryUsage(query: UsageQuery): Promise<UsageDataPoint[]>;
  /** Flush the write queue and wait for inserts to complete. */
  flush(): Promise<void>;
}

/** Retention period — rows older than this are deleted on startup. */
const RETENTION_DAYS = 365;

/** Write queue flush interval in milliseconds. */
const FLUSH_INTERVAL_MS = 5_000;

/** Maximum records per batch before triggering an immediate flush. */
const FLUSH_BATCH_SIZE = 50;

/** Maximum records in the write queue before dropping new records. */
const MAX_QUEUE_SIZE = 10_000;

class ModelCallLoggerModule implements ModelCallLogger {
  private client: Client | null = null;
  private db: LibSQLDatabase<ModelCallSchema> | null = null;
  private started = false;

  private readonly writeQueue: ModelCallRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      dataDirectory: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    const dbPath = `${this.deps.dataDirectory}/model-calls.sqlite`;
    this.client = createClient({ url: `file:${dbPath}` });

    // Enable WAL mode for concurrent read/write access and reduce fsync
    // overhead. PRAGMAs must be executed individually — executeMultiple
    // does not reliably support PRAGMA statements.
    await this.client.execute('PRAGMA journal_mode=WAL');
    await this.client.execute('PRAGMA synchronous=NORMAL');

    this.db = drizzle(this.client, {
      schema: { meta: metaTable, model_calls: modelCallsTable },
    });

    await migrateDatabase({
      db: this.db as unknown as Parameters<typeof migrateDatabase>[0]['db'],
      client: this.client,
      registry: MODEL_CALL_MIGRATIONS,
      initSql: MODEL_CALL_INIT_SQL,
      schemaVersion: MODEL_CALL_SCHEMA_VERSION,
    });

    await this.runRetentionCleanup();

    this.flushTimer = setInterval(() => {
      this.flushQueue().catch((error: unknown) => {
        this.deps.logger.error({ error }, 'Model call queue flush failed');
      });
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();

    this.started = true;
    this.deps.logger.info(
      { dbPath, retentionDays: RETENTION_DAYS },
      'ModelCallLogger started',
    );
  }

  async flush(): Promise<void> {
    if (!this.started) return;
    await this.flushQueue();
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any remaining queued records.
    await this.flushQueue();

    this.client?.close();
    this.client = null;
    this.db = null;

    this.deps.logger.info('ModelCallLogger stopped');
  }

  recordCall(record: ModelCallRecord): void {
    if (!this.started) return;

    if (this.writeQueue.length >= MAX_QUEUE_SIZE) {
      this.deps.logger.warn(
        { queueLength: this.writeQueue.length },
        'Model call write queue full — dropping record',
      );
      return;
    }

    this.writeQueue.push(record);

    if (this.writeQueue.length >= FLUSH_BATCH_SIZE) {
      this.flushQueue().catch((error: unknown) => {
        this.deps.logger.error({ error }, 'Model call queue flush failed');
      });
    }
  }

  async queryUsage(query: UsageQuery): Promise<UsageDataPoint[]> {
    if (!this.db || !this.client) {
      throw new Error('ModelCallLogger not started');
    }

    if (query.granularity === 'event') {
      return this.queryEvents(query);
    }

    return this.queryAggregated(query);
  }

  // ---------------------------------------------------------------------------
  // Private — write path
  // ---------------------------------------------------------------------------

  private async flushQueue(): Promise<void> {
    if (this.writeQueue.length === 0 || !this.client) return;

    const batch = this.writeQueue.splice(0, this.writeQueue.length);

    // Build a multi-row INSERT as a single batched statement.
    // A unique sentinel object distinguishes SQL NULL from the literal string "NULL".
    const NULL_SENTINEL = Symbol('null');
    const valueList = batch
      .map((r) => {
        const escaped = [
          r.id,
          r.sessionId,
          r.providerId,
          r.endpointId,
          r.modelId,
          r.source,
          r.extensionId,
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.inputCacheWriteTokens),
          String(r.inputCacheReadTokens),
          r.ttftMs != null ? String(r.ttftMs) : NULL_SENTINEL,
          r.totalDurationMs != null ? String(r.totalDurationMs) : NULL_SENTINEL,
          r.finishReason,
          r.isError ? '1' : '0',
          r.errorType,
          r.startedAt,
          r.finishedAt,
        ]
          .map((v) =>
            v === null || v === NULL_SENTINEL
              ? 'NULL'
              : `'${String(v).replace(/'/g, "''")}'`,
          )
          .join(', ');
        return `(${escaped})`;
      })
      .join(', ');

    try {
      await this.client.executeMultiple(`
INSERT OR IGNORE INTO model_calls (
  id, session_id, provider_id, endpoint_id, model_id, source, extension_id,
  input_tokens, output_tokens, input_cache_write_tokens, input_cache_read_tokens,
  ttft_ms, total_duration_ms, finish_reason, is_error, error_type,
  started_at, finished_at
) VALUES ${valueList};
`);
    } catch (error) {
      // Re-queue the failed batch at the front for retry on next flush.
      this.writeQueue.unshift(...batch);
      this.deps.logger.error(
        { error, batchSize: batch.length, queueLength: this.writeQueue.length },
        'Failed to batch-insert model call records — re-queued for retry',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private — read path
  // ---------------------------------------------------------------------------

  private async queryEvents(query: UsageQuery): Promise<UsageDataPoint[]> {
    if (!this.db) throw new Error('ModelCallLogger not started');

    const conditions = [];
    if (query.from) conditions.push(gte(modelCallsTable.startedAt, query.from));
    if (query.to) conditions.push(lt(modelCallsTable.startedAt, query.to));

    const rows = await this.db
      .select()
      .from(modelCallsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(modelCallsTable.startedAt))
      .limit(query.limit);

    return rows.map((row) => ({
      bucket: null,
      splitKey: this.resolveSplitKey(row, query.splitBy),
      callCount: 1,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      inputCacheWriteTokens: row.inputCacheWriteTokens,
      inputCacheReadTokens: row.inputCacheReadTokens,
      ttftMs: row.ttftMs,
      totalDurationMs: row.totalDurationMs,
      errorCount: row.isError ? 1 : 0,
      id: row.id,
      sessionId: row.sessionId,
      providerId: row.providerId,
      endpointId: row.endpointId,
      modelId: row.modelId,
      source: row.source as ModelCallSource,
      extensionId: row.extensionId,
      finishReason: row.finishReason,
      errorType: row.errorType,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    }));
  }

  private async queryAggregated(query: UsageQuery): Promise<UsageDataPoint[]> {
    if (!this.client) throw new Error('ModelCallLogger not started');

    const bucketExpr = this.bucketExpression(query.granularity);
    const splitSelect = this.splitColumn(query.splitBy);

    const conditions: string[] = [];
    const args: string[] = [];
    if (query.from) {
      conditions.push('started_at >= ?');
      args.push(query.from);
    }
    if (query.to) {
      conditions.push('started_at < ?');
      args.push(query.to);
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const groupByClause =
      query.splitBy === 'none'
        ? 'GROUP BY bucket'
        : 'GROUP BY bucket, split_key';

    const orderByClause =
      query.splitBy === 'none'
        ? 'ORDER BY bucket'
        : 'ORDER BY bucket, split_key';

    const queryString = `
SELECT
  ${bucketExpr} AS bucket,
  ${splitSelect} AS split_key,
  COUNT(*) AS call_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(input_cache_write_tokens) AS input_cache_write_tokens,
  SUM(input_cache_read_tokens) AS input_cache_read_tokens,
  AVG(ttft_ms) AS ttft_ms,
  AVG(total_duration_ms) AS total_duration_ms,
  SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS error_count
FROM model_calls
${whereClause}
${groupByClause}
${orderByClause}
`;

    const result = await this.client.execute({ sql: queryString, args });

    return result.rows.map((row) => ({
      bucket: (row.bucket as string | null) ?? null,
      splitKey: (row.split_key as string | null) ?? null,
      callCount: Number(row.call_count ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      inputCacheWriteTokens: Number(row.input_cache_write_tokens ?? 0),
      inputCacheReadTokens: Number(row.input_cache_read_tokens ?? 0),
      ttftMs: row.ttft_ms != null ? Number(row.ttft_ms) : null,
      totalDurationMs:
        row.total_duration_ms != null ? Number(row.total_duration_ms) : null,
      errorCount: Number(row.error_count ?? 0),
      id: null,
      sessionId: null,
      providerId: null,
      endpointId: null,
      modelId: null,
      source: null,
      extensionId: null,
      finishReason: null,
      errorType: null,
      startedAt: null,
      finishedAt: null,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private — helpers
  // ---------------------------------------------------------------------------

  private bucketExpression(granularity: UsageGranularity): string {
    // SQLite strftime formats the started_at (ISO 8601 string) into a
    // bucket key. The format depends on the requested granularity.
    switch (granularity) {
      case 'hourly':
        return "strftime('%Y-%m-%dT%H:00:00', started_at)";
      case 'daily':
        return "strftime('%Y-%m-%d', started_at)";
      case 'weekly':
        // Compute the Monday of the week as the bucket key.
        // %w=0 is Sunday; (w+6)%7 gives days since Monday.
        return "date(started_at, '-' || ((strftime('%w', started_at) + 6) % 7) || ' days')";
      default:
        return 'NULL';
    }
  }

  private splitColumn(splitBy: UsageSplitBy): string {
    switch (splitBy) {
      case 'model':
        return 'model_id';
      case 'provider':
        return 'provider_id';
      case 'endpoint':
        return 'endpoint_id';
      default:
        return 'NULL';
    }
  }

  /**
   * Resolves the split key for event-level queries from the row's
   * individual columns. Mirrors the SQL-side `splitColumn` but works
   * on the already-fetched row.
   */
  private resolveSplitKey(
    row: {
      providerId: string | null;
      endpointId: string | null;
      modelId: string | null;
    },
    splitBy: UsageSplitBy,
  ): string | null {
    switch (splitBy) {
      case 'model':
        return row.modelId;
      case 'provider':
        return row.providerId;
      case 'endpoint':
        return row.endpointId;
      default:
        return null;
    }
  }

  private async runRetentionCleanup(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.execute({
        sql: `DELETE FROM model_calls WHERE started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days')`,
        args: [String(RETENTION_DAYS)],
      });
      this.deps.logger.info(
        { retentionDays: RETENTION_DAYS },
        'Model call retention cleanup completed',
      );
    } catch (error) {
      this.deps.logger.error({ error }, 'Model call retention cleanup failed');
    }
  }
}

export function createModelCallLogger(
  deps: ModelCallLoggerDependencies,
): ModelCallLogger {
  return new ModelCallLoggerModule({
    logger: deps.logging.child({
      name: 'model-call-logger',
      bindings: { module: 'model-call-logger' },
    }),
    dataDirectory: deps.dataDirectory,
  });
}
