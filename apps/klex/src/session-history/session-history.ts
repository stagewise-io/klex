import {
  type Client,
  createClient,
  type InStatement,
  type Row,
} from '@libsql/client';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config, KlexConfig } from '@/config';
import { assertCurrentSqliteStore } from '@/local-data';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { SessionKind } from '@/session/types';

import {
  SESSION_HISTORY_RELATIVE_PATH,
  SESSION_HISTORY_STORE_DEFINITION,
} from './schema';
import type {
  SessionHistoryListPage,
  SessionHistoryListQuery,
  SessionHistoryMessage,
  SessionHistoryMessagesPage,
  SessionHistoryMessagesQuery,
  SessionHistoryRecord,
  SessionHistoryRecorder,
  SessionHistoryRecorderMetadata,
} from './types';

export interface SessionHistoryDependencies {
  logging: RootLogger;
  dataDirectory: string;
  config: Pick<Config, 'get'>;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface SessionHistory {
  start(): Promise<void>;
  /** Drain pending writes, then close the database. */
  close(): Promise<void>;
  openRecorder(meta: SessionHistoryRecorderMetadata): SessionHistoryRecorder;
  listSessions(query: SessionHistoryListQuery): Promise<SessionHistoryListPage>;
  getSession(instanceId: string): Promise<SessionHistoryRecord | undefined>;
  /** Returns `undefined` when the instance is unknown. */
  getMessages(
    instanceId: string,
    query: SessionHistoryMessagesQuery,
  ): Promise<SessionHistoryMessagesPage | undefined>;
  /** Wait until all queued writes have completed. */
  flush(): Promise<void>;
  /** Run size-cap enforcement immediately on the write queue. */
  enforceSizeCap(): Promise<void>;
}

/** Thrown by `listSessions` when the cursor cannot be decoded. */
export class InvalidSessionHistoryCursorError extends Error {
  constructor() {
    super('Invalid session history cursor');
    this.name = 'InvalidSessionHistoryCursorError';
  }
}

/** Default size cap of the stored message bytes (512 MiB). */
export const DEFAULT_SESSION_HISTORY_MAX_BYTES = 512 * 1024 * 1024;

/** Enforcement evicts down to this fraction of the cap. */
const EVICTION_TARGET_RATIO = 0.9;

/** Minimum interval between write-triggered enforcement runs. */
const ENFORCEMENT_THROTTLE_MS = 30_000;

/** Rows fetched per eviction query. */
const EVICTION_BATCH_SIZE = 200;

const SESSION_KINDS: readonly SessionKind[] = ['default', 'god', 'child'];

export function resolveSessionHistoryMaxBytes(
  config: Readonly<KlexConfig>,
): number {
  return config.sessionHistory?.maxBytes ?? DEFAULT_SESSION_HISTORY_MAX_BYTES;
}

/** Per-instance write state. Only mutated on the store write queue. */
class RecorderState implements SessionHistoryRecorder {
  /** Message objects as of the last committed write, by `seq`. */
  persisted: readonly ExtendedUIMessage[] = [];
  /** `persisted_at` values as of the last committed write, by `seq`. */
  persistedAt: string[] = [];
  /** Leading `seq` values removed by size-cap enforcement. */
  trimmed = 0;
  inserted = false;
  ended = false;
  pending: (() => readonly ExtendedUIMessage[]) | null = null;
  lastGetter: (() => readonly ExtendedUIMessage[]) | null = null;
  scheduled = false;

  constructor(
    readonly meta: SessionHistoryRecorderMetadata,
    private readonly store: SessionHistoryModule,
  ) {}

  get instanceId(): string {
    return this.meta.instanceId;
  }

  scheduleSync(getMessages: () => readonly ExtendedUIMessage[]): void {
    if (this.ended) return;
    this.pending = getMessages;
    this.lastGetter = getMessages;
    if (this.scheduled) return;
    this.scheduled = true;
    void this.store.enqueue(() => this.store.runSync(this));
  }

  end(reason: string): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.ended = true;
    return this.store.enqueue(() => this.store.runEnd(this, reason));
  }
}

class SessionHistoryModule implements SessionHistory {
  private client: Client | null = null;
  private started = false;
  /** Set once `close()` has closed the client; later writes are dropped. */
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private lastEnforcementAt = 0;
  private readonly liveRecorders = new Map<string, RecorderState>();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      dataDirectory: string;
      config: Pick<Config, 'get'>;
      now: () => Date;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    const dbPath = `${this.deps.dataDirectory}/${SESSION_HISTORY_RELATIVE_PATH}`;
    await assertCurrentSqliteStore(
      dbPath,
      SESSION_HISTORY_STORE_DEFINITION,
      this.deps.dataDirectory,
    );
    const client = createClient({ url: `file:${dbPath}` });
    try {
      // PRAGMAs must be executed individually.
      await client.execute('PRAGMA journal_mode=WAL');
      await client.execute('PRAGMA synchronous=NORMAL');

      const recovered = await client.execute({
        sql: `UPDATE sessions
              SET ended_at = updated_at, end_reason = 'unclean_shutdown'
              WHERE ended_at IS NULL`,
        args: [],
      });
      if (recovered.rowsAffected > 0) {
        this.deps.logger.info(
          { sessions: recovered.rowsAffected },
          'Marked unfinished session histories as unclean shutdown',
        );
      }
    } catch (error) {
      client.close();
      throw error;
    }

    this.client = client;
    this.closed = false;
    this.started = true;
    await this.enqueue(() => this.runEnforcement());

    this.deps.logger.info({ dbPath }, 'SessionHistory started');
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Tasks may enqueue more work (a concurrent `end()`, enforcement after a
    // committed sync); drain until the queue stops growing.
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
    this.client?.close();
    this.client = null;
    this.closed = true;
    this.liveRecorders.clear();
    this.deps.logger.info('SessionHistory stopped');
  }

  flush(): Promise<void> {
    return this.queue;
  }

  enforceSizeCap(): Promise<void> {
    return this.enqueue(() => this.runEnforcement());
  }

  openRecorder(meta: SessionHistoryRecorderMetadata): SessionHistoryRecorder {
    const recorder = new RecorderState(meta, this);
    this.liveRecorders.set(meta.instanceId, recorder);
    return recorder;
  }

  /** Serialize `task` behind all queued writes. Never rejects. */
  enqueue(task: () => Promise<void>): Promise<void> {
    if (this.closed) {
      this.deps.logger.warn('Session history write dropped after close');
      return Promise.resolve();
    }
    const run = this.queue.then(task).catch((error: unknown) => {
      this.deps.logger.error({ error }, 'Session history write task failed');
    });
    this.queue = run;
    return run;
  }

  async runSync(recorder: RecorderState): Promise<void> {
    recorder.scheduled = false;
    const getMessages = recorder.pending;
    recorder.pending = null;
    if (!getMessages) return;
    const committed = await this.syncRecorder(recorder, getMessages);
    if (committed) this.maybeScheduleEnforcement();
  }

  async runEnd(recorder: RecorderState, reason: string): Promise<void> {
    // Always run a final sync to capture changes after the last schedule.
    const getMessages = recorder.lastGetter;
    recorder.pending = null;
    this.liveRecorders.delete(recorder.instanceId);
    if (getMessages) await this.syncRecorder(recorder, getMessages);
    const client = this.client;
    if (!client || !recorder.inserted) return;
    try {
      await client.execute({
        sql: `UPDATE sessions SET ended_at = ?, end_reason = ? WHERE instance_id = ?`,
        args: [this.nowIso(), reason, recorder.instanceId],
      });
    } catch (error) {
      this.deps.logger.error(
        { error, instanceId: recorder.instanceId },
        'Failed to mark session history as ended',
      );
      return;
    }
    await this.runEnforcement();
  }

  /** Returns `true` when a write was committed. Never throws. */
  private async syncRecorder(
    recorder: RecorderState,
    getMessages: () => readonly ExtendedUIMessage[],
  ): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      const snapshot = [...getMessages()];
      return await this.writeSnapshot(client, recorder, snapshot);
    } catch (error) {
      // Keep the getter so the next sync retries the whole diff.
      recorder.pending ??= getMessages;
      this.deps.logger.error(
        { error, instanceId: recorder.instanceId },
        'Session history sync failed',
      );
      return false;
    }
  }

  private async writeSnapshot(
    client: Client,
    recorder: RecorderState,
    snapshot: readonly ExtendedUIMessage[],
  ): Promise<boolean> {
    if (snapshot.length === 0 && !recorder.inserted) return false;

    const previous = recorder.persisted;
    const shared = Math.min(previous.length, snapshot.length);
    let first = 0;
    while (first < shared && previous[first] === snapshot[first]) first++;
    // Always rewrite the last message to capture in-place mutations.
    if (snapshot.length > 0) first = Math.min(first, snapshot.length - 1);
    const start = Math.max(first, recorder.trimmed);

    const now = this.nowIso();
    const { meta } = recorder;
    const statements: InStatement[] = [];
    if (!recorder.inserted) {
      statements.push({
        sql: `INSERT INTO sessions (
                instance_id, session_id, kind, name, parent_instance_id,
                extension_identifier, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (instance_id) DO NOTHING`,
        args: [
          meta.instanceId,
          meta.sessionId,
          meta.kind,
          meta.name,
          meta.parentInstanceId ?? null,
          meta.extensionIdentifier ?? null,
          meta.createdAt,
          now,
        ],
      });
    }
    statements.push({
      sql: 'DELETE FROM messages WHERE instance_id = ? AND seq >= ?',
      args: [meta.instanceId, start],
    });

    const persistedAt = recorder.persistedAt.slice(0, start);
    for (let seq = start; seq < snapshot.length; seq++) {
      const message = snapshot[seq];
      if (!message) continue;
      const content = JSON.stringify(message);
      const previousAt = recorder.persistedAt[seq];
      const at =
        previous[seq] === message && previousAt !== undefined
          ? previousAt
          : now;
      persistedAt[seq] = at;
      statements.push({
        sql: `INSERT INTO messages (
                instance_id, seq, message_id, role, content, byte_size, persisted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          meta.instanceId,
          seq,
          message.id,
          message.role,
          content,
          Buffer.byteLength(content, 'utf8'),
          at,
        ],
      });
    }
    statements.push({
      sql: `UPDATE sessions SET
              message_count = ?,
              byte_size = (
                SELECT COALESCE(SUM(byte_size), 0) FROM messages WHERE instance_id = ?
              ),
              updated_at = ?
            WHERE instance_id = ?`,
      args: [snapshot.length, meta.instanceId, now, meta.instanceId],
    });

    await client.batch(statements, 'write');
    recorder.persisted = snapshot;
    recorder.persistedAt = persistedAt;
    recorder.inserted = true;
    return true;
  }

  private maybeScheduleEnforcement(): void {
    const now = this.deps.now().getTime();
    if (now - this.lastEnforcementAt < ENFORCEMENT_THROTTLE_MS) return;
    this.lastEnforcementAt = now;
    void this.enqueue(() => this.runEnforcement());
  }

  /** Must run on the write queue. Never throws. */
  private async runEnforcement(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.lastEnforcementAt = this.deps.now().getTime();
    try {
      await this.evict(client);
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Session history size enforcement failed',
      );
    }
  }

  private async evict(client: Client): Promise<void> {
    const maxBytes = resolveSessionHistoryMaxBytes(this.deps.config.get());
    const totalResult = await client.execute(
      'SELECT COALESCE(SUM(byte_size), 0) AS total FROM sessions',
    );
    const initialTotal = toNumber(totalResult.rows[0]?.total);
    if (initialTotal <= maxBytes) return;

    const target = Math.floor(maxBytes * EVICTION_TARGET_RATIO);
    let total = initialTotal;
    let evictedSessions = 0;
    let trimmedMessages = 0;

    // 1. Oldest ended sessions first.
    while (total > target) {
      const result = await client.execute({
        sql: `SELECT instance_id, byte_size FROM sessions
              WHERE ended_at IS NOT NULL
              ORDER BY ended_at ASC, instance_id ASC
              LIMIT ?`,
        args: [EVICTION_BATCH_SIZE],
      });
      if (result.rows.length === 0) break;
      const statements: InStatement[] = [];
      for (const row of result.rows) {
        if (total <= target) break;
        const instanceId = toText(row.instance_id);
        statements.push(
          {
            sql: 'DELETE FROM messages WHERE instance_id = ?',
            args: [instanceId],
          },
          {
            sql: 'DELETE FROM sessions WHERE instance_id = ?',
            args: [instanceId],
          },
        );
        total -= toNumber(row.byte_size);
        evictedSessions++;
      }
      await client.batch(statements, 'write');
    }

    // 2. Oldest messages of live sessions, keeping each session's newest one.
    if (total > target) {
      const live = await client.execute(
        `SELECT instance_id FROM sessions WHERE ended_at IS NULL
         ORDER BY created_at ASC, instance_id ASC`,
      );
      for (const sessionRow of live.rows) {
        if (total <= target) break;
        const instanceId = toText(sessionRow.instance_id);
        while (total > target) {
          const result = await client.execute({
            sql: `SELECT seq, byte_size FROM messages
                  WHERE instance_id = ?
                    AND seq < (SELECT MAX(seq) FROM messages WHERE instance_id = ?)
                  ORDER BY seq ASC
                  LIMIT ?`,
            args: [instanceId, instanceId, EVICTION_BATCH_SIZE],
          });
          if (result.rows.length === 0) break;
          let lastSeq = -1;
          let removedBytes = 0;
          let removed = 0;
          for (const row of result.rows) {
            if (total <= target) break;
            lastSeq = toNumber(row.seq);
            const bytes = toNumber(row.byte_size);
            removedBytes += bytes;
            total -= bytes;
            removed++;
          }
          if (lastSeq < 0) break;
          await client.batch(
            [
              {
                sql: 'DELETE FROM messages WHERE instance_id = ? AND seq <= ?',
                args: [instanceId, lastSeq],
              },
              {
                sql: `UPDATE sessions
                      SET trimmed_message_count = ?, byte_size = byte_size - ?
                      WHERE instance_id = ?`,
                args: [lastSeq + 1, removedBytes, instanceId],
              },
            ],
            'write',
          );
          trimmedMessages += removed;
          const recorder = this.liveRecorders.get(instanceId);
          if (recorder) recorder.trimmed = lastSeq + 1;
        }
      }
    }

    // `execute` steps the pragma once and frees a single page;
    // `executeMultiple` runs it to completion.
    await client.executeMultiple('PRAGMA incremental_vacuum;');
    this.deps.logger.info(
      {
        maxBytes,
        bytesBefore: initialTotal,
        bytesAfter: total,
        evictedSessions,
        trimmedMessages,
      },
      'Session history size cap enforced',
    );
  }

  async listSessions(
    query: SessionHistoryListQuery,
  ): Promise<SessionHistoryListPage> {
    const client = this.requireClient();
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (query.kind) {
      conditions.push('kind = ?');
      args.push(query.kind);
    }
    if (query.parentInstanceId) {
      conditions.push('parent_instance_id = ?');
      args.push(query.parentInstanceId);
    }
    if (query.live !== undefined) {
      conditions.push(query.live ? 'ended_at IS NULL' : 'ended_at IS NOT NULL');
    }
    if (query.cursor) {
      const [createdAt, instanceId] = decodeListCursor(query.cursor);
      conditions.push(
        '(created_at < ? OR (created_at = ? AND instance_id < ?))',
      );
      args.push(createdAt, createdAt, instanceId);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await client.execute({
      sql: `SELECT * FROM sessions ${where}
            ORDER BY created_at DESC, instance_id DESC
            LIMIT ?`,
      args: [...args, query.limit + 1],
    });
    const hasMore = result.rows.length > query.limit;
    const sessions = result.rows.slice(0, query.limit).map(toSessionRecord);
    const last = sessions.at(-1);
    return {
      sessions,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeListCursor(last.createdAt, last.instanceId)
          : null,
    };
  }

  async getSession(
    instanceId: string,
  ): Promise<SessionHistoryRecord | undefined> {
    const client = this.requireClient();
    const result = await client.execute({
      sql: 'SELECT * FROM sessions WHERE instance_id = ?',
      args: [instanceId],
    });
    const row = result.rows[0];
    return row ? toSessionRecord(row) : undefined;
  }

  async getMessages(
    instanceId: string,
    query: SessionHistoryMessagesQuery,
  ): Promise<SessionHistoryMessagesPage | undefined> {
    const session = await this.getSession(instanceId);
    if (!session) return undefined;
    const client = this.requireClient();
    const result = await client.execute({
      sql: `SELECT seq, content, persisted_at FROM messages
            WHERE instance_id = ? AND (? IS NULL OR seq < ?)
            ORDER BY seq DESC
            LIMIT ?`,
      args: [
        instanceId,
        query.beforeSeq ?? null,
        query.beforeSeq ?? null,
        query.limit + 1,
      ],
    });
    const hasMore = result.rows.length > query.limit;
    const messages: SessionHistoryMessage[] = result.rows
      .slice(0, query.limit)
      .reverse()
      .map((row) => ({
        seq: toNumber(row.seq),
        persistedAt: toText(row.persisted_at),
        message: parseMessage(toText(row.content)),
      }));
    return {
      messages,
      hasMore,
      nextCursor: hasMore ? (messages[0]?.seq ?? null) : null,
      trimmedMessageCount: session.trimmedMessageCount,
    };
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('SessionHistory is not started');
    return this.client;
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }
}

function parseMessage(content: string): ExtendedUIMessage {
  const message: ExtendedUIMessage = JSON.parse(content);
  return message;
}

function encodeListCursor(createdAt: string, instanceId: string): string {
  return Buffer.from(JSON.stringify([createdAt, instanceId]), 'utf8').toString(
    'base64url',
  );
}

function decodeListCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // Fall through to the typed error.
  }
  throw new InvalidSessionHistoryCursorError();
}

function toSessionRecord(row: Row): SessionHistoryRecord {
  const endedAt = toNullableText(row.ended_at);
  return {
    instanceId: toText(row.instance_id),
    sessionId: toText(row.session_id),
    kind: toSessionKind(toText(row.kind)),
    name: toText(row.name),
    parentInstanceId: toNullableText(row.parent_instance_id),
    extensionIdentifier: toNullableText(row.extension_identifier),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    endedAt,
    endReason: toNullableText(row.end_reason),
    live: endedAt === null,
    messageCount: toNumber(row.message_count),
    trimmedMessageCount: toNumber(row.trimmed_message_count),
    byteSize: toNumber(row.byte_size),
  };
}

function toSessionKind(value: string): SessionKind {
  const kind = SESSION_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`Unknown session kind in history store: ${value}`);
  return kind;
}

/** Row cells; `undefined` under `noUncheckedIndexedAccess`. */
type Cell = Row[string] | undefined;

function toText(value: Cell): string {
  return value === null || value === undefined ? '' : String(value);
}

function toNullableText(value: Cell): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: Cell): number {
  return typeof value === 'number' || typeof value === 'bigint'
    ? Number(value)
    : Number(value ?? 0);
}

export function createSessionHistory(
  deps: SessionHistoryDependencies,
): SessionHistory {
  return new SessionHistoryModule({
    logger: deps.logging.child({
      name: 'session-history',
      bindings: { module: 'session-history' },
    }),
    dataDirectory: deps.dataDirectory,
    config: deps.config,
    now: deps.now ?? (() => new Date()),
  });
}
