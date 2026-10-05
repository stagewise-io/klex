import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type {
  GetEventsResult,
  PushNotification,
} from '@stagewise/mcp-extension-push-notifications';

import type { MachineLogger } from '../logger.js';
import {
  type ShellEventInfo,
  shellLostEvent,
  type WatcherEventInfo,
  watcherLostEvent,
} from './events.js';

export const MAX_PENDING_EVENTS_PER_PRINCIPAL = 256;
export const PENDING_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 100;
const STATE_VERSION = 1;

export interface WatcherRecordInfo extends WatcherEventInfo {
  deadlineAt: string;
}

export type TrackedItem =
  | {
      id: string;
      principalId: string;
      kind: 'watcher';
      info: WatcherRecordInfo;
    }
  | { id: string; principalId: string; kind: 'shell'; info: ShellEventInfo };

export type NotificationRecord = TrackedItem &
  ({ state: 'running' } | { state: 'pending'; event: PushNotification });

export type NotificationListener = (event: PushNotification) => void;

export interface NotificationStore {
  ready(): Promise<void>;
  /** Records a running item. Persists before resolving. */
  track(item: TrackedItem): Promise<void>;
  /** Moves a running item to pending. Persists, then notifies listeners. */
  complete(id: string, event: PushNotification): Promise<void>;
  /** Removes a record without emitting (cancel or explicit close). */
  forget(id: string): Promise<void>;
  pending(principalId: string, limit?: number): GetEventsResult;
  acknowledge(principalId: string, eventIds: readonly string[]): Promise<void>;
  records(principalId: string): NotificationRecord[];
  onEvent(principalId: string, listener: NotificationListener): () => void;
  readonly persistent: boolean;
  close(): Promise<void>;
}

export interface NotificationStoreOptions {
  /** Persists to `<dataDir>/notifications/`. Memory-only when omitted. */
  dataDir?: string;
  logger: MachineLogger;
  now?: () => number;
}

export class TooManyPendingNotificationsError extends Error {
  constructor() {
    super('Too many unacknowledged notifications');
  }
}

export function createNotificationStore(
  options: NotificationStoreOptions,
): NotificationStore {
  return new FileNotificationStore(options);
}

class FileNotificationStore implements NotificationStore {
  readonly #logger: MachineLogger;
  readonly #now: () => number;
  readonly #directory: string | undefined;
  readonly #records = new Map<string, NotificationRecord>();
  readonly #listeners = new Map<string, Set<NotificationListener>>();
  #writes: Promise<void> = Promise.resolve();
  #lockPath: string | undefined;
  #ready: Promise<void> | undefined;
  #closed = false;

  constructor(options: NotificationStoreOptions) {
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#directory = options.dataDir
      ? join(options.dataDir, 'notifications')
      : undefined;
  }

  get persistent(): boolean {
    return this.#lockPath !== undefined;
  }

  ready(): Promise<void> {
    this.#ready ??= this.#initialize();
    return this.#ready;
  }

  async track(item: TrackedItem): Promise<void> {
    this.#assertOpen();
    this.#dropExpired();
    if (this.#records.has(item.id))
      throw new Error(`Duplicate notification record: ${item.id}`);
    if (
      this.#pendingFor(item.principalId).length >=
      MAX_PENDING_EVENTS_PER_PRINCIPAL
    ) {
      throw new TooManyPendingNotificationsError();
    }
    this.#records.set(item.id, { ...structuredClone(item), state: 'running' });
    try {
      await this.#persist();
    } catch (error) {
      this.#records.delete(item.id);
      throw error;
    }
  }

  async complete(id: string, event: PushNotification): Promise<void> {
    const record = this.#records.get(id);
    if (record?.state !== 'running') return;
    const pending: NotificationRecord = {
      ...record,
      state: 'pending',
      event: structuredClone(event),
    };
    this.#records.set(id, pending);
    try {
      await this.#persist();
    } catch (error) {
      // The event stays retrievable from memory; only restart durability is lost.
      this.#logger.error(
        { eventId: event.eventId, error: errorMessage(error) },
        'Failed to persist notification',
      );
      return;
    }
    // Cancellation or acknowledgement during the write suppresses live delivery.
    if (this.#records.get(id) !== pending) return;
    for (const listener of this.#listeners.get(record.principalId) ?? []) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        this.#logger.error(
          { eventId: event.eventId, error: errorMessage(error) },
          'Notification listener failed',
        );
      }
    }
  }

  async forget(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.delete(id);
    try {
      await this.#persist();
    } catch (error) {
      if (!this.#records.has(id)) this.#records.set(id, record);
      throw error;
    }
  }

  pending(principalId: string, limit = DEFAULT_PAGE_SIZE): GetEventsResult {
    this.#dropExpired();
    const size = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_SIZE);
    const events = this.#pendingFor(principalId);
    return {
      events: events.slice(0, size).map((event) => structuredClone(event)),
      hasMore: events.length > size,
    };
  }

  async acknowledge(
    principalId: string,
    eventIds: readonly string[],
  ): Promise<void> {
    const ids = new Set(eventIds);
    const removed = new Map<string, NotificationRecord>();
    for (const [id, record] of this.#records) {
      if (
        record.principalId === principalId &&
        record.state === 'pending' &&
        ids.has(record.event.eventId)
      ) {
        this.#records.delete(id);
        removed.set(id, record);
      }
    }
    if (removed.size > 0) {
      try {
        await this.#persist();
      } catch (error) {
        for (const [id, record] of removed) {
          if (!this.#records.has(id)) this.#records.set(id, record);
        }
        throw error;
      }
    }
  }

  records(principalId: string): NotificationRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.principalId === principalId)
      .map((record) => structuredClone(record));
  }

  onEvent(principalId: string, listener: NotificationListener): () => void {
    let listeners = this.#listeners.get(principalId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(principalId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(principalId);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#ready?.catch(() => {});
    await this.#writes;
    this.#listeners.clear();
    if (this.#lockPath) {
      await rm(this.#lockPath, { force: true });
      this.#lockPath = undefined;
    }
  }

  async #initialize(): Promise<void> {
    if (!this.#directory) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!(await this.#acquireLock())) return;
    try {
      await this.#load();
      const lostAt = new Date(this.#now()).toISOString();
      for (const [id, record] of this.#records) {
        if (record.state !== 'running') continue;
        const event =
          record.kind === 'watcher'
            ? watcherLostEvent(record.info, lostAt)
            : shellLostEvent(record.info, lostAt);
        this.#records.set(id, { ...record, state: 'pending', event });
      }
      this.#dropExpired();
      await this.#persist();
    } catch (error) {
      if (this.#lockPath) await rm(this.#lockPath, { force: true });
      this.#lockPath = undefined;
      throw error;
    }
  }

  async #acquireLock(): Promise<boolean> {
    const directory = this.#directory as string;
    const lockPath = join(directory, 'lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.close();
        this.#lockPath = lockPath;
        return true;
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
      const holder = Number.parseInt(
        await readFile(lockPath, 'utf8').catch(() => ''),
        10,
      );
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        this.#logger.warn(
          { lockPath, pid: holder },
          'Notification state is locked by another klex-machine process; notifications are memory-only',
        );
        return false;
      }
      await rm(lockPath, { force: true });
    }
    this.#logger.warn(
      { lockPath },
      'Could not acquire notification state lock; notifications are memory-only',
    );
    return false;
  }

  async #load(): Promise<void> {
    const path = this.#statePath();
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        !isObject(parsed) ||
        parsed.version !== STATE_VERSION ||
        !Array.isArray(parsed.records)
      ) {
        throw new Error('Unsupported notification state format');
      }
      for (const record of parsed.records) {
        if (!isNotificationRecord(record)) {
          throw new Error('Invalid notification record');
        }
        this.#records.set(record.id, record);
      }
    } catch (error) {
      this.#records.clear();
      const quarantine = `${path}.corrupt-${this.#now()}`;
      await rename(path, quarantine);
      this.#logger.error(
        { path, quarantine, error: errorMessage(error) },
        'Notification state is corrupt; starting empty',
      );
    }
  }

  #persist(): Promise<void> {
    if (!this.#lockPath) return Promise.resolve();
    const snapshot = `${JSON.stringify(
      { version: STATE_VERSION, records: [...this.#records.values()] },
      null,
      2,
    )}\n`;
    const write = this.#writes.then(() => this.#writeState(snapshot));
    this.#writes = write.catch(() => {});
    return write;
  }

  async #persistLogged(): Promise<void> {
    await this.#persist().catch((error: unknown) => {
      this.#logger.error(
        { error: errorMessage(error) },
        'Failed to persist notification state',
      );
    });
  }

  async #writeState(snapshot: string): Promise<void> {
    const path = this.#statePath();
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, snapshot, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  #statePath(): string {
    return join(this.#directory as string, 'state.json');
  }

  #pendingFor(principalId: string): PushNotification[] {
    const events: PushNotification[] = [];
    for (const record of this.#records.values()) {
      if (record.principalId === principalId && record.state === 'pending') {
        events.push(record.event);
      }
    }
    return events.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  #dropExpired(): void {
    const cutoff = this.#now() - PENDING_EVENT_TTL_MS;
    let changed = false;
    for (const [id, record] of this.#records) {
      if (record.state !== 'pending') continue;
      if (Date.parse(record.event.createdAt) >= cutoff) continue;
      this.#records.delete(id);
      changed = true;
      this.#logger.warn(
        {
          eventId: record.event.eventId,
          type: record.event.type,
          principalId: record.principalId,
        },
        'Dropped unacknowledged notification older than 7 days',
      );
    }
    if (changed && this.#ready) void this.#persistLogged();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Notification store is closed');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (!isObject(value) || !isObject(value.info)) return false;
  if (typeof value.id !== 'string' || typeof value.principalId !== 'string') {
    return false;
  }
  if (value.kind !== 'watcher' && value.kind !== 'shell') return false;
  const fields =
    value.kind === 'watcher'
      ? ['watcherId', 'title', 'command', 'cwd', 'createdAt', 'deadlineAt']
      : ['sessionId', 'shell', 'cwd', 'createdAt'];
  const info = value.info;
  if (!fields.every((field) => typeof info[field] === 'string')) return false;
  if (!Number.isFinite(Date.parse(String(info.createdAt)))) return false;
  if (value.state === 'running') return true;
  return (
    value.state === 'pending' &&
    isObject(value.event) &&
    typeof value.event.eventId === 'string' &&
    typeof value.event.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.event.createdAt)) &&
    typeof value.event.type === 'string' &&
    typeof value.event.sourceId === 'string' &&
    Array.isArray(value.event.content)
  );
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, 'EPERM');
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
