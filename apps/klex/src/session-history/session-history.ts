import { createHash } from 'node:crypto';

import {
  type Client,
  createClient,
  type InStatement,
  type Row,
} from '@libsql/client';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { GenerationHealthErrorSchema } from '@/admin-api/routes/v1/schemas';
import type { Config, KlexConfig } from '@/config';
import { assertCurrentSqliteStore } from '@/local-data';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { SessionKind } from '@/session/types';

import type {
  GenerationFailure,
  GenerationHealthError,
} from './generation-health';
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
  SessionHistoryWindow,
  SessionHistoryWindowEntry,
  SessionHistoryWindowQuery,
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
  /**
   * Load the restorable window of a logical session: the latest checkpoint
   * header plus all later messages, or the newest messages within
   * `fallbackMaxBytes` when no checkpoint exists. Runs on the write queue,
   * so it observes every write enqueued before the call.
   */
  loadWindow(
    sessionId: string,
    query: SessionHistoryWindowQuery,
  ): Promise<SessionHistoryWindow>;
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

/**
 * Logical session whose restorable window is protected from size-cap
 * eviction. Only the default session is restored across restarts.
 */
const PROTECTED_SESSION_ID = 'default';

const SESSION_KINDS: readonly SessionKind[] = ['default', 'god', 'child'];

export function resolveSessionHistoryMaxBytes(
  config: Readonly<KlexConfig>,
): number {
  return config.sessionHistory?.maxBytes ?? DEFAULT_SESSION_HISTORY_MAX_BYTES;
}

/** Persisted state of one window message. */
interface RecordedEntry {
  ord: number;
  /**
   * Content hash as of the last committed write. Content, not object
   * identity, decides what is rewritten: history repair mutates older
   * messages in place.
   */
  hash: string;
  /** Instance that wrote the row (differs for restored messages). */
  instanceId: string;
  /** Checkpoint headers keep their `ord` outside the window order. */
  isCheckpoint: boolean;
  /**
   * False for a committed checkpoint header that has not appeared in a
   * synced window yet; its absence must not delete the row.
   */
  seen: boolean;
}

/** Per-instance write state. Entries are only mutated on the write queue. */
class RecorderState implements SessionHistoryRecorder {
  /** Persisted window messages by message ID. */
  entries = new Map<string, RecordedEntry>();
  /**
   * IDs announced as trimmed. Written synchronously by the session, consumed
   * by the next sync, so a sync that runs after the trim forgets instead of
   * deleting them.
   */
  readonly pendingTrimmed = new Set<string>();
  /** Rows written by this instance minus rolled-back ones. */
  messageCount = 0;
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

  recordGenerationFailure(
    failure: GenerationFailure,
    kind: GenerationHealthError['kind'],
    consecutiveFailures: number,
  ): Promise<void> {
    if (this.ended) return Promise.resolve();
    return this.store.enqueue(() =>
      this.store.runGenerationHealth(this, {
        ...failure,
        kind,
        consecutiveFailures,
      }),
    );
  }

  clearGenerationFailure(): Promise<void> {
    if (this.ended) return Promise.resolve();
    return this.store.enqueue(() => this.store.runGenerationHealth(this, null));
  }

  scheduleSync(getMessages: () => readonly ExtendedUIMessage[]): void {
    if (this.ended) return;
    this.pending = getMessages;
    this.lastGetter = getMessages;
    if (this.scheduled) return;
    this.scheduled = true;
    void this.store.enqueue(() => this.store.runSync(this));
  }

  seed(window: SessionHistoryWindow): void {
    for (const entry of window.entries) {
      this.entries.set(entry.message.id, {
        ord: entry.ord,
        hash: entry.hash,
        instanceId: entry.instanceId,
        isCheckpoint: entry.isCheckpoint,
        seen: true,
      });
    }
  }

  markTrimmed(messageIds: readonly string[]): void {
    for (const id of messageIds) this.pendingTrimmed.add(id);
  }

  commitCheckpoint(
    header: ExtendedUIMessage,
    coversThroughMessageId: string,
    getMessages: () => readonly ExtendedUIMessage[],
  ): Promise<void> {
    if (this.ended) {
      return Promise.reject(new Error('Session history recorder has ended'));
    }
    this.lastGetter = getMessages;
    return this.store.enqueueResult(() =>
      this.store.runCommitCheckpoint(
        this,
        header,
        coversThroughMessageId,
        getMessages,
      ),
    );
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
  private enforcementTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly liveRecorders = new Map<string, RecorderState>();
  /**
   * Next free `ord` per logical session. Valid because this process holds
   * the data-directory lock and every write goes through the queue.
   */
  private readonly nextOrds = new Map<string, number>();

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
    if (this.enforcementTimer) {
      clearTimeout(this.enforcementTimer);
      this.enforcementTimer = null;
    }
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
    this.nextOrds.clear();
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

  /**
   * Serialize `task` behind all queued writes and propagate its outcome.
   * The queue itself never rejects.
   */
  enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('SessionHistory is closed'));
    }
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async runCommitCheckpoint(
    recorder: RecorderState,
    header: ExtendedUIMessage,
    coversThroughMessageId: string,
    getMessages: () => readonly ExtendedUIMessage[],
  ): Promise<void> {
    const client = this.requireClient();
    // Persist the window first so the anchor and the raw tail are durable.
    recorder.pending = null;
    await this.writeSnapshot(client, recorder, [...getMessages()]);
    const anchor = recorder.entries.get(coversThroughMessageId);
    if (!anchor || anchor.isCheckpoint) {
      throw new Error(
        `Checkpoint anchor ${coversThroughMessageId} is not persisted`,
      );
    }
    const { meta } = recorder;
    const now = this.nowIso();
    const content = JSON.stringify(header);
    const ord = await this.peekOrd(client, meta.sessionId);
    await client.batch(
      [
        {
          sql: `INSERT INTO messages (
                  session_id, ord, instance_id, message_id, role, content,
                  byte_size, persisted_at, is_checkpoint, covers_through_ord
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          args: [
            meta.sessionId,
            ord,
            meta.instanceId,
            header.id,
            header.role,
            content,
            Buffer.byteLength(content, 'utf8'),
            now,
            anchor.ord,
          ],
        },
        ...this.sessionTotalsStatements(
          meta.instanceId,
          recorder.messageCount + 1,
          new Set(),
          now,
        ),
      ],
      'write',
    );
    this.nextOrds.set(meta.sessionId, ord + 1);
    recorder.messageCount++;
    recorder.entries.set(header.id, {
      ord,
      hash: hashContent(content),
      instanceId: meta.instanceId,
      isCheckpoint: true,
      seen: false,
    });
    this.maybeScheduleEnforcement();
  }

  /** Next free `ord` of `sessionId`; callers advance the cache on commit. */
  private async peekOrd(client: Client, sessionId: string): Promise<number> {
    const cached = this.nextOrds.get(sessionId);
    if (cached !== undefined) return cached;
    const result = await client.execute({
      sql: 'SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM messages WHERE session_id = ?',
      args: [sessionId],
    });
    const next = toNumber(result.rows[0]?.next);
    this.nextOrds.set(sessionId, next);
    return next;
  }

  /** Session-row bookkeeping after a write by `recorder`. */
  private sessionTotalsStatements(
    instanceId: string,
    messageCount: number,
    touchedInstances: ReadonlySet<string>,
    now: string,
    /** Rows of other instances this write rolled back. */
    removedByInstance: ReadonlyMap<string, number> = new Map(),
  ): InStatement[] {
    const others = [...touchedInstances].filter((id) => id !== instanceId);
    const statements: InStatement[] = [
      {
        sql: `UPDATE sessions SET
                message_count = ?,
                byte_size = (
                  SELECT COALESCE(SUM(byte_size), 0) FROM messages WHERE instance_id = ?
                ),
                updated_at = ?
              WHERE instance_id = ?`,
        args: [messageCount, instanceId, now, instanceId],
      },
    ];
    // Restored rows of earlier instances may have been rewritten or rolled
    // back. `message_count` survives eviction, so decrement, not recount.
    for (const other of others) {
      statements.push({
        sql: `UPDATE sessions SET
                message_count = MAX(0, message_count - ?),
                byte_size = (
                  SELECT COALESCE(SUM(byte_size), 0) FROM messages WHERE instance_id = ?
                )
              WHERE instance_id = ?`,
        args: [removedByInstance.get(other) ?? 0, other, other],
      });
    }
    return statements;
  }

  async runSync(recorder: RecorderState): Promise<void> {
    recorder.scheduled = false;
    const getMessages = recorder.pending;
    recorder.pending = null;
    if (!getMessages) return;
    const committed = await this.syncRecorder(recorder, getMessages);
    if (committed) this.maybeScheduleEnforcement();
  }

  async runGenerationHealth(
    recorder: RecorderState,
    failure:
      | (GenerationFailure &
          Pick<GenerationHealthError, 'kind' | 'consecutiveFailures'>)
      | null,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const { meta } = recorder;
      const now = this.nowIso();
      const previous = await client.execute({
        sql: 'SELECT generation_error FROM sessions WHERE instance_id = ?',
        args: [meta.instanceId],
      });
      const raw = previous.rows[0]?.generation_error;
      const old = parseGenerationError(raw);
      // Termination is an escalation of the same failure, not a new incident.
      const identical =
        old &&
        failure &&
        [
          'category',
          'reason',
          'message',
          'providerId',
          'providerType',
          'modelId',
          'statusCode',
        ].every(
          (key) =>
            old[key as keyof GenerationFailure] ===
            failure[key as keyof GenerationFailure],
        );
      const health: GenerationHealthError | null = failure
        ? {
            ...failure,
            occurrenceCount: identical ? old.occurrenceCount + 1 : 1,
            firstSeenAt: identical ? old.firstSeenAt : now,
            lastSeenAt: now,
          }
        : null;
      const statements: InStatement[] = [];
      if (health)
        statements.push({
          sql: `INSERT INTO sessions (instance_id, session_id, kind, name, parent_instance_id,
        extension_identifier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      // A newer occurrence supersedes every unresolved warning for this logical
      // session. Recovery resolves only this instance and its predecessors.
      statements.push({
        sql: `UPDATE sessions SET generation_error = NULL WHERE session_id = ?
        AND (? = 1 OR created_at < ? OR (created_at = ? AND rowid <= COALESCE(
          (SELECT rowid FROM sessions WHERE instance_id = ?), 9223372036854775807)))`,
        args: [
          meta.sessionId,
          health ? 1 : 0,
          meta.createdAt,
          meta.createdAt,
          meta.instanceId,
        ],
      });
      if (health)
        statements.push({
          sql: 'UPDATE sessions SET generation_error = ?, updated_at = ? WHERE instance_id = ?',
          args: [JSON.stringify(health), now, meta.instanceId],
        });
      await client.batch(statements, 'write');
      if (health) recorder.inserted = true;
    } catch (error) {
      this.deps.logger.error(
        { error, instanceId: recorder.instanceId },
        'Failed to update session generation health',
      );
    }
  }

  async runEnd(recorder: RecorderState, reason: string): Promise<void> {
    // Always run a final sync to capture changes after the last schedule.
    const getMessages = recorder.lastGetter;
    recorder.pending = null;
    this.liveRecorders.delete(recorder.instanceId);
    if (getMessages) {
      await this.syncRecorder(recorder, getMessages);
      // A failed sync leaves its getter pending. Later schedules are ignored
      // after `end()`, so retry once before the end marker is written.
      const retry = recorder.pending;
      recorder.pending = null;
      if (retry) await this.syncRecorder(recorder, retry);
    }
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

    const now = this.nowIso();
    const { meta } = recorder;
    const statements: InStatement[] = [];
    let changed = !recorder.inserted;
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

    // Addressing is by message ID. `ord` must follow window order for
    // non-checkpoint rows, so restore reproduces the window: new messages
    // take the next `ord`, and known messages that now follow a newer one
    // (a mid-window insert) move to a fresh `ord`. Checkpoint headers keep
    // their `ord` and are excluded from the order check. Rows evicted by the
    // size cap stay known, so updates to them affect nothing and they are
    // never restored.
    const nextEntries = new Map<string, RecordedEntry>();
    const touched = new Set<string>([meta.instanceId]);
    const removedByInstance = new Map<string, number>();
    let nextOrd = await this.peekOrd(client, meta.sessionId);
    let lastOrd = -1;
    let messageCount = recorder.messageCount;
    for (const message of snapshot) {
      if (nextEntries.has(message.id)) continue;
      const content = JSON.stringify(message);
      const hash = hashContent(content);
      const bytes = Buffer.byteLength(content, 'utf8');
      const previous = recorder.entries.get(message.id);
      if (previous?.isCheckpoint) {
        nextEntries.set(message.id, { ...previous, hash, seen: true });
        if (previous.hash === hash) continue;
        changed = true;
        touched.add(previous.instanceId);
        statements.push({
          sql: `UPDATE messages SET role = ?, content = ?, byte_size = ?, persisted_at = ?
                WHERE session_id = ? AND ord = ?`,
          args: [
            message.role,
            content,
            bytes,
            now,
            meta.sessionId,
            previous.ord,
          ],
        });
        continue;
      }
      if (previous && previous.ord > lastOrd) {
        lastOrd = previous.ord;
        nextEntries.set(message.id, { ...previous, hash });
        if (previous.hash === hash) continue;
        changed = true;
        touched.add(previous.instanceId);
        statements.push({
          sql: `UPDATE messages SET role = ?, content = ?, byte_size = ?, persisted_at = ?
                WHERE session_id = ? AND ord = ?`,
          args: [
            message.role,
            content,
            bytes,
            now,
            meta.sessionId,
            previous.ord,
          ],
        });
        continue;
      }
      const ord = nextOrd++;
      lastOrd = ord;
      changed = true;
      if (previous) {
        touched.add(previous.instanceId);
        nextEntries.set(message.id, { ...previous, ord, hash });
        statements.push({
          sql: `UPDATE messages SET ord = ?, role = ?, content = ?, byte_size = ?, persisted_at = ?
                WHERE session_id = ? AND ord = ?`,
          args: [
            ord,
            message.role,
            content,
            bytes,
            now,
            meta.sessionId,
            previous.ord,
          ],
        });
        continue;
      }
      messageCount++;
      nextEntries.set(message.id, {
        ord,
        hash,
        instanceId: meta.instanceId,
        isCheckpoint: false,
        seen: true,
      });
      statements.push({
        sql: `INSERT INTO messages (
                session_id, ord, instance_id, message_id, role, content,
                byte_size, persisted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          meta.sessionId,
          ord,
          meta.instanceId,
          message.id,
          message.role,
          content,
          bytes,
          now,
        ],
      });
    }
    const trimmed: string[] = [];
    for (const [id, entry] of recorder.entries) {
      if (nextEntries.has(id)) continue;
      if (recorder.pendingTrimmed.has(id)) {
        trimmed.push(id);
        continue;
      }
      if (entry.isCheckpoint && !entry.seen) {
        nextEntries.set(id, entry);
        continue;
      }
      // Removed from the window without a trim: a rollback.
      changed = true;
      touched.add(entry.instanceId);
      if (entry.instanceId === meta.instanceId) {
        messageCount--;
      } else {
        removedByInstance.set(
          entry.instanceId,
          (removedByInstance.get(entry.instanceId) ?? 0) + 1,
        );
      }
      statements.push({
        sql: 'DELETE FROM messages WHERE session_id = ? AND ord = ?',
        args: [meta.sessionId, entry.ord],
      });
    }
    if (!changed) {
      recorder.entries = nextEntries;
      for (const id of trimmed) recorder.pendingTrimmed.delete(id);
      this.prunePendingTrimmed(recorder);
      return false;
    }

    statements.push(
      ...this.sessionTotalsStatements(
        meta.instanceId,
        messageCount,
        touched,
        now,
        removedByInstance,
      ),
    );

    await client.batch(statements, 'write');
    this.nextOrds.set(meta.sessionId, nextOrd);
    recorder.entries = nextEntries;
    recorder.messageCount = messageCount;
    for (const id of trimmed) recorder.pendingTrimmed.delete(id);
    this.prunePendingTrimmed(recorder);
    recorder.inserted = true;
    return true;
  }

  /** Drop trim announcements for IDs that were never persisted. */
  private prunePendingTrimmed(recorder: RecorderState): void {
    for (const id of recorder.pendingTrimmed) {
      if (!recorder.entries.has(id)) recorder.pendingTrimmed.delete(id);
    }
  }

  private maybeScheduleEnforcement(): void {
    const now = this.deps.now().getTime();
    const wait = this.lastEnforcementAt + ENFORCEMENT_THROTTLE_MS - now;
    if (wait <= 0) {
      this.lastEnforcementAt = now;
      void this.enqueue(() => this.runEnforcement());
      return;
    }
    // Throttled: defer instead of skipping, so a write that crosses the cap
    // is enforced even when the session goes idle afterwards.
    if (this.enforcementTimer) return;
    this.enforcementTimer = setTimeout(() => {
      this.enforcementTimer = null;
      if (!this.started) return;
      void this.enqueue(() => this.runEnforcement());
    }, wait);
    this.enforcementTimer.unref();
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
    // The default session's restorable window (latest checkpoint and its
    // tail) is never evicted, regardless of which instance wrote it. Without
    // a checkpoint nothing is protected, so a single oversized message cannot
    // pin the store above the cap.
    const deletable = await this.deletablePredicate(client);

    // 1. Oldest ended sessions first. Sessions holding protected rows keep
    // those rows and their session row.
    let cursor: { endedAt: string; instanceId: string } | null = null;
    while (total > target) {
      const result: Awaited<ReturnType<Client['execute']>> =
        await client.execute({
          sql: `SELECT instance_id, ended_at FROM sessions
                WHERE ended_at IS NOT NULL
                  AND (? IS NULL OR ended_at > ? OR (ended_at = ? AND instance_id > ?))
                ORDER BY ended_at ASC, instance_id ASC
                LIMIT ?`,
          args: [
            cursor?.endedAt ?? null,
            cursor?.endedAt ?? null,
            cursor?.endedAt ?? null,
            cursor?.instanceId ?? null,
            EVICTION_BATCH_SIZE,
          ],
        });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        if (total <= target) break;
        const instanceId = toText(row.instance_id);
        cursor = { endedAt: toText(row.ended_at), instanceId };
        const counts = await client.execute({
          sql: `SELECT
                  COALESCE(SUM(CASE WHEN ${deletable.sql} THEN byte_size END), 0) AS bytes,
                  COUNT(CASE WHEN ${deletable.sql} THEN 1 END) AS removable,
                  COUNT(*) AS rows
                FROM messages WHERE instance_id = ?`,
          args: [...deletable.args, ...deletable.args, instanceId],
        });
        const bytes = toNumber(counts.rows[0]?.bytes);
        const removable = toNumber(counts.rows[0]?.removable);
        const rows = toNumber(counts.rows[0]?.rows);
        if (removable === rows) {
          await client.batch(
            [
              {
                sql: 'DELETE FROM messages WHERE instance_id = ?',
                args: [instanceId],
              },
              {
                sql: 'DELETE FROM sessions WHERE instance_id = ? AND generation_error IS NULL',
                args: [instanceId],
              },
              {
                sql: 'UPDATE sessions SET byte_size = 0, trimmed_message_count = trimmed_message_count + ? WHERE instance_id = ?',
                args: [removable, instanceId],
              },
            ],
            'write',
          );
          evictedSessions++;
        } else if (removable > 0) {
          await client.batch(
            [
              {
                sql: `DELETE FROM messages WHERE instance_id = ? AND ${deletable.sql}`,
                args: [instanceId, ...deletable.args],
              },
              {
                sql: `UPDATE sessions
                      SET trimmed_message_count = trimmed_message_count + ?,
                          byte_size = byte_size - ?
                      WHERE instance_id = ?`,
                args: [removable, bytes, instanceId],
              },
            ],
            'write',
          );
          trimmedMessages += removable;
        }
        total -= bytes;
      }
    }

    // 2. Oldest unprotected messages of live sessions. This can include a
    // session's newest message.
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
            sql: `SELECT session_id, ord, byte_size FROM messages
                  WHERE instance_id = ? AND ${deletable.sql}
                  ORDER BY ord ASC
                  LIMIT ?`,
            args: [instanceId, ...deletable.args, EVICTION_BATCH_SIZE],
          });
          if (result.rows.length === 0) break;
          const statements: InStatement[] = [];
          let removedBytes = 0;
          let removed = 0;
          for (const row of result.rows) {
            if (total <= target) break;
            const bytes = toNumber(row.byte_size);
            statements.push({
              sql: 'DELETE FROM messages WHERE session_id = ? AND ord = ?',
              args: [toText(row.session_id), toNumber(row.ord)],
            });
            removedBytes += bytes;
            total -= bytes;
            removed++;
          }
          if (removed === 0) break;
          statements.push({
            sql: `UPDATE sessions
                  SET trimmed_message_count = trimmed_message_count + ?,
                      byte_size = byte_size - ?
                  WHERE instance_id = ?`,
            args: [removed, removedBytes, instanceId],
          });
          await client.batch(statements, 'write');
          trimmedMessages += removed;
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

  /**
   * SQL predicate (over `messages` columns) matching rows outside the
   * protected default-session window.
   */
  private async deletablePredicate(
    client: Client,
  ): Promise<{ sql: string; args: (string | number)[] }> {
    const checkpoint = await this.latestCheckpoint(
      client,
      PROTECTED_SESSION_ID,
    );
    if (!checkpoint) return { sql: '1 = 1', args: [] };
    return {
      sql: `NOT (session_id = ? AND (ord = ? OR (ord > ? AND is_checkpoint = 0)))`,
      args: [PROTECTED_SESSION_ID, checkpoint.ord, checkpoint.coversThroughOrd],
    };
  }

  private async latestCheckpoint(
    client: Client,
    sessionId: string,
  ): Promise<
    | {
        ord: number;
        coversThroughOrd: number;
        instanceId: string;
        content: string;
      }
    | undefined
  > {
    const result = await client.execute({
      sql: `SELECT ord, covers_through_ord, instance_id, content FROM messages
            WHERE session_id = ? AND is_checkpoint = 1
            ORDER BY ord DESC
            LIMIT 1`,
      args: [sessionId],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ord: toNumber(row.ord),
      coversThroughOrd: toNumber(row.covers_through_ord),
      instanceId: toText(row.instance_id),
      content: toText(row.content),
    };
  }

  loadWindow(
    sessionId: string,
    query: SessionHistoryWindowQuery,
  ): Promise<SessionHistoryWindow> {
    return this.enqueueResult(async () => {
      const client = this.requireClient();
      const checkpoint = await this.latestCheckpoint(client, sessionId);
      if (checkpoint) {
        const tail = await client.execute({
          sql: `SELECT ord, instance_id, content FROM messages
                WHERE session_id = ? AND is_checkpoint = 0 AND ord > ?
                ORDER BY ord ASC`,
          args: [sessionId, checkpoint.coversThroughOrd],
        });
        return {
          hasCheckpoint: true,
          entries: [
            toWindowEntry(
              checkpoint.ord,
              checkpoint.instanceId,
              checkpoint.content,
              true,
            ),
            ...tail.rows.map((row) =>
              toWindowEntry(
                toNumber(row.ord),
                toText(row.instance_id),
                toText(row.content),
                false,
              ),
            ),
          ],
        };
      }
      // No checkpoint: newest messages within the byte budget, starting at
      // a user message so the window never opens mid-step.
      const entries: SessionHistoryWindowEntry[] = [];
      let bytes = 0;
      let beforeOrd: number | null = null;
      let exhausted = false;
      while (!exhausted) {
        const page: Awaited<ReturnType<Client['execute']>> =
          await client.execute({
            sql: `SELECT ord, instance_id, content, byte_size FROM messages
                  WHERE session_id = ? AND is_checkpoint = 0
                    AND (? IS NULL OR ord < ?)
                  ORDER BY ord DESC
                  LIMIT ?`,
            args: [sessionId, beforeOrd, beforeOrd, EVICTION_BATCH_SIZE],
          });
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          const size = toNumber(row.byte_size);
          if (bytes + size > query.fallbackMaxBytes) {
            exhausted = true;
            break;
          }
          bytes += size;
          beforeOrd = toNumber(row.ord);
          entries.push(
            toWindowEntry(
              beforeOrd,
              toText(row.instance_id),
              toText(row.content),
              false,
            ),
          );
        }
        if (page.rows.length < EVICTION_BATCH_SIZE) break;
      }
      entries.reverse();
      const firstUser = entries.findIndex(
        (entry) => entry.message.role === 'user',
      );
      return {
        hasCheckpoint: false,
        entries: firstUser < 0 ? [] : entries.slice(firstUser),
      };
    });
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
      sql: `SELECT ord, content, persisted_at FROM messages
            WHERE instance_id = ? AND (? IS NULL OR ord < ?)
            ORDER BY ord DESC
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
        seq: toNumber(row.ord),
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

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('base64');
}

function toWindowEntry(
  ord: number,
  instanceId: string,
  content: string,
  isCheckpoint: boolean,
): SessionHistoryWindowEntry {
  return {
    message: parseMessage(content),
    ord,
    instanceId,
    isCheckpoint,
    hash: hashContent(content),
  };
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
    generationError: parseGenerationError(row.generation_error),
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

function parseGenerationError(value: Cell): GenerationHealthError | null {
  if (typeof value !== 'string') return null;
  try {
    const result = GenerationHealthErrorSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

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
