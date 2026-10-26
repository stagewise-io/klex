import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { type KlexConfig, klexConfigSchema } from '@/config';
import type { SqliteStoreDefinition } from '@/local-data';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { summarizeGenerationFailure } from './generation-health';
import {
  CHECKPOINT_PART_TYPE,
  SESSION_HISTORY_INIT_SQL,
  SESSION_HISTORY_RELATIVE_PATH,
  SESSION_HISTORY_STORE_DEFINITION,
} from './schema';
import {
  createSessionHistory,
  DEFAULT_SESSION_HISTORY_MAX_BYTES,
  InvalidSessionHistoryCursorError,
  resolveSessionHistoryMaxBytes,
  type SessionHistory,
} from './session-history';
import type { SessionHistoryRecorderMetadata } from './types';

const logger = createLogger({ name: 'test' });
const directories: string[] = [];
const modules: SessionHistory[] = [];

function message(id: string, text = id, role = 'user'): ExtendedUIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
  } as unknown as ExtendedUIMessage;
}

function meta(
  overrides: Partial<SessionHistoryRecorderMetadata> = {},
): SessionHistoryRecorderMetadata {
  return {
    instanceId: randomUUID(),
    sessionId: 'default',
    kind: 'default',
    name: 'Default',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(options: { maxBytes?: number; directory?: string } = {}) {
  const directory =
    options.directory ??
    (await mkdtemp(join(tmpdir(), 'klex-session-history-')));
  if (!options.directory) directories.push(directory);
  await createLocalData({
    logging: logger,
    dataDirectory: directory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  let config: KlexConfig = klexConfigSchema.parse({});
  if (options.maxBytes !== undefined) {
    config = { ...config, sessionHistory: { maxBytes: options.maxBytes } };
  }
  const history = createSessionHistory({
    logging: logger,
    dataDirectory: directory,
    config: { get: () => config },
  });
  modules.push(history);
  await history.start();
  return {
    directory,
    history,
    setMaxBytes(maxBytes: number) {
      config = { ...config, sessionHistory: { maxBytes } };
    },
  };
}

async function storedIds(history: SessionHistory, instanceId: string) {
  const page = await history.getMessages(instanceId, { limit: 200 });
  return page?.messages.map((entry) => entry.message.id);
}

afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('resolveSessionHistoryMaxBytes', () => {
  it('uses the default unless the config overrides it', () => {
    const config = klexConfigSchema.parse({});
    expect(resolveSessionHistoryMaxBytes(config)).toBe(
      DEFAULT_SESSION_HISTORY_MAX_BYTES,
    );
    expect(
      resolveSessionHistoryMaxBytes({
        ...config,
        sessionHistory: { maxBytes: 32 * 1024 * 1024 },
      }),
    ).toBe(32 * 1024 * 1024);
  });
});

describe('session history sync', () => {
  it.each(['{broken', '{"category":"rate_limit"}', 'null', '[]'])(
    'ignores invalid stored generation health (%s) and replaces it',
    async (value) => {
      const { history, directory } = await setup();
      const recorder = history.openRecorder(meta());
      const failure = summarizeGenerationFailure(
        new Error('rate limit TPM: 30000'),
      );
      await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
      const raw = createClient({
        url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
      });
      try {
        await raw.execute({
          sql: 'UPDATE sessions SET generation_error = ? WHERE instance_id = ?',
          args: [value, recorder.instanceId],
        });
        expect(
          (await history.getSession(recorder.instanceId))?.generationError,
        ).toBeNull();
        expect(
          (await history.listSessions({ limit: 10 })).sessions,
        ).toMatchObject([
          { instanceId: recorder.instanceId, generationError: null },
        ]);
        await expect(
          recorder.recordGenerationFailure(failure, 'turn_failed', 2),
        ).resolves.toBeUndefined();
        expect(
          (await history.getSession(recorder.instanceId))?.generationError,
        ).toMatchObject({
          ...failure,
          consecutiveFailures: 2,
          occurrenceCount: 1,
        });
      } finally {
        raw.close();
      }
    },
  );

  it('does not reject generation health writes when SQLite rejects updates or the store is closed', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      await raw.execute(`CREATE TRIGGER reject_health BEFORE UPDATE ON sessions
        BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`);
      await expect(
        recorder.recordGenerationFailure(failure, 'turn_failed', 2),
      ).resolves.toBeUndefined();
      await expect(recorder.clearGenerationFailure()).resolves.toBeUndefined();
      expect(
        (await history.getSession(recorder.instanceId))?.generationError
          ?.occurrenceCount,
      ).toBe(1);
    } finally {
      raw.close();
    }
    await history.close();
    await expect(
      recorder.recordGenerationFailure(failure, 'turn_failed', 3),
    ).resolves.toBeUndefined();
    await expect(recorder.clearGenerationFailure()).resolves.toBeUndefined();
  });

  it('retains unresolved warning metadata when the size cap evicts its transcript', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(
      meta({ kind: 'child', sessionId: 'child' }),
    );
    recorder.scheduleSync(() => [message('large', 'x'.repeat(1000))]);
    await recorder.recordGenerationFailure(
      summarizeGenerationFailure(new Error('rate limit')),
      'terminated',
      5,
    );
    await recorder.end('failed');
    setMaxBytes(1);
    await history.enforceSizeCap();
    expect(await history.getSession(recorder.instanceId)).toMatchObject({
      byteSize: 0,
      trimmedMessageCount: 1,
      generationError: { kind: 'terminated' },
    });
    expect(await storedIds(history, recorder.instanceId)).toEqual([]);
  });

  it('supersedes warnings with tied instance timestamps and resets counts for a different failure', async () => {
    const { history } = await setup();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const old = history.openRecorder(meta({ createdAt }));
    const replacement = history.openRecorder(meta({ createdAt }));
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await old.recordGenerationFailure(failure, 'turn_failed', 1);
    await replacement.recordGenerationFailure(failure, 'turn_failed', 1);
    await old.clearGenerationFailure();
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).not.toBeNull();
    // A late failure is a newer occurrence, so there must still be only one warning.
    await old.recordGenerationFailure(failure, 'turn_failed', 2);
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).toBeNull();
    await old.recordGenerationFailure(
      summarizeGenerationFailure(new Error('billing quota exhausted')),
      'turn_failed',
      3,
    );
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toMatchObject({ category: 'quota', occurrenceCount: 1 });
    await replacement.clearGenerationFailure();
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
  });

  it('migrates v2 additively, restores failed migrations, and rejects downgrade writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-history-v2-'));
    directories.push(directory);
    const v2: SqliteStoreDefinition = {
      ...SESSION_HISTORY_STORE_DEFINITION,
      schemaVersion: 2,
      minimumKlexVersion: '0.23.0',
      initSql: SESSION_HISTORY_INIT_SQL.replace(
        '  generation_error TEXT,\n',
        '',
      ),
      migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.filter(
        (migration) => migration.to <= 2,
      ),
      validate: async (client) => {
        await client.execute('SELECT instance_id FROM sessions LIMIT 1');
      },
    };
    const migrate = (store: SqliteStoreDefinition) =>
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [store],
      }).start();
    await migrate(v2);
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    await raw.execute(
      "INSERT INTO sessions (instance_id, session_id, kind, name, created_at, updated_at) VALUES ('old', 'default', 'default', 'old', '2026-01-01', '2026-01-01')",
    );
    raw.close();
    const broken: SqliteStoreDefinition = {
      ...SESSION_HISTORY_STORE_DEFINITION,
      migrations: [
        ...v2.migrations,
        {
          from: 2,
          to: 3,
          name: 'failure',
          up: async (db) => {
            await db.execute(
              'ALTER TABLE sessions ADD COLUMN generation_error TEXT',
            );
            throw new Error('injected migration failure');
          },
        },
      ],
    };
    await expect(migrate(broken)).rejects.toThrow(/restored/);
    await migrate(v2);
    await migrate(SESSION_HISTORY_STORE_DEFINITION);
    const { history } = await setup({ directory });
    expect(await history.getSession('old')).toMatchObject({
      generationError: null,
      name: 'old',
    });
    await history.close();
    await expect(migrate(v2)).rejects.toThrow(/schema=3.*schema=2/);
  });

  it('persists and deduplicates zero-message failures through sync, end, and restart', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const failure = summarizeGenerationFailure(
      new Error('rate limit TPM: 30000'),
    );
    await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
    const first = (await history.getSession(recorder.instanceId))
      ?.generationError;
    expect(first).toMatchObject({ occurrenceCount: 1, consecutiveFailures: 1 });
    for (let count = 2; count <= 5; count++)
      await recorder.recordGenerationFailure(
        failure,
        count === 5 ? 'terminated' : 'turn_failed',
        count,
      );
    recorder.scheduleSync(() => []);
    await recorder.end('max_consecutive_failures');
    await history.close();
    const reopened = await setup({ directory });
    expect(
      await reopened.history.getSession(recorder.instanceId),
    ).toMatchObject({
      live: false,
      messageCount: 0,
      generationError: {
        kind: 'terminated',
        occurrenceCount: 5,
        consecutiveFailures: 5,
        firstSeenAt: first?.firstSeenAt,
      },
    });
  });

  it('retains an ended failure until replacement failure or success, independently of child sessions', async () => {
    const { history } = await setup();
    const old = history.openRecorder(
      meta({ createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    const child = history.openRecorder(
      meta({ sessionId: 'child', kind: 'child' }),
    );
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await old.recordGenerationFailure(failure, 'terminated', 5);
    await old.end('failed');
    await child.recordGenerationFailure(failure, 'request_rejected', 1);
    const replacement = history.openRecorder(
      meta({ createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).not.toBeNull();
    await replacement.recordGenerationFailure(failure, 'turn_failed', 1);
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
    replacement.scheduleSync(() => [message('after-failure')]);
    await history.flush();
    expect(
      (await history.getSession(replacement.instanceId))?.messageCount,
    ).toBe(1);
    await replacement.end('failed');
    const recovered = history.openRecorder(
      meta({ createdAt: '2026-01-03T00:00:00.000Z' }),
    );
    await recovered.clearGenerationFailure();
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).toBeNull();
    expect(
      (await history.getSession(child.instanceId))?.generationError,
    ).not.toBeNull();
  });

  it('persists in-place mutations of older messages', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const repaired = message('a', 'pending', 'assistant');
    const messages = [repaired, message('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    // History repair mutates an older message after newer input arrived.
    repaired.parts = [{ type: 'text', text: 'repaired' }];
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(page?.messages.map((entry) => entry.message.parts)).toEqual([
      [{ type: 'text', text: 'repaired' }],
      [{ type: 'text', text: 'b' }],
      [{ type: 'text', text: 'c' }],
    ]);
  });

  it('lazily inserts the session and appends messages', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta({ name: 'Main' }));
    await history.flush();
    expect(await history.getSession(recorder.instanceId)).toBeUndefined();

    const messages = [message('a'), message('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({
      name: 'Main',
      kind: 'default',
      live: true,
      messageCount: 3,
      trimmedMessageCount: 0,
    });
    expect(session?.byteSize).toBeGreaterThan(0);
  });

  it('rewrites from a mid-history insert and handles truncation', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    messages.splice(1, 0, message('x'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'x',
      'b',
      'c',
    ]);

    messages.splice(2, 2);
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'x']);
    expect((await history.getSession(recorder.instanceId))?.messageCount).toBe(
      2,
    );
  });

  it('captures in-place mutations of the last message', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const last = message('a', 'partial');
    const messages = [last];
    recorder.scheduleSync(() => messages);
    await history.flush();

    Object.assign(last, { parts: [{ type: 'text', text: 'complete' }] });
    recorder.scheduleSync(() => messages);
    await history.flush();

    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(page?.messages[0]?.message.parts).toEqual([
      { type: 'text', text: 'complete' },
    ]);
  });

  it('coalesces concurrent schedules into one snapshot', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages: ExtendedUIMessage[] = [];
    let reads = 0;
    const getter = () => {
      reads++;
      return messages;
    };
    for (let index = 0; index < 5; index++) {
      messages.push(message(`m${index}`));
      recorder.scheduleSync(getter);
    }
    await history.flush();
    expect(reads).toBe(1);
    expect(await storedIds(history, recorder.instanceId)).toHaveLength(5);
  });

  it('retries after a failed sync without throwing', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => {
      throw new Error('boom');
    });
    await history.flush();
    expect(await history.getSession(recorder.instanceId)).toBeUndefined();

    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
  });

  it('runs a final sync on end and records the reason', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => messages);
    await history.flush();
    messages.push(message('b'));
    await recorder.end('closed');

    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({ live: false, endReason: 'closed' });
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);

    recorder.scheduleSync(() => [...messages, message('c')]);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);
  });

  it('marks unfinished sessions as unclean shutdown on startup', async () => {
    const first = await setup();
    const recorder = first.history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await first.history.close();

    const second = await setup({ directory: first.directory });
    const session = await second.history.getSession(recorder.instanceId);
    expect(session).toMatchObject({
      live: false,
      endReason: 'unclean_shutdown',
    });
  });

  it('drains writes enqueued while closing', async () => {
    const first = await setup();
    const recorder = first.history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => messages);
    const closing = first.history.close();
    messages.push(message('b'));
    const ending = recorder.end('closed');
    await Promise.all([closing, ending]);

    const second = await setup({ directory: first.directory });
    expect(await second.history.getSession(recorder.instanceId)).toMatchObject({
      live: false,
      endReason: 'closed',
    });
    expect(await storedIds(second.history, recorder.instanceId)).toEqual([
      'a',
      'b',
    ]);
  });

  it.each(['schemaVersion', 'compatibilityVersion'])(
    'rejects a store with a newer %s without mutating it',
    async (key) => {
      const first = await setup();
      const recorder = first.history.openRecorder(meta());
      recorder.scheduleSync(() => [message('a')]);
      await first.history.close();

      const raw = createClient({
        url: `file:${join(first.directory, SESSION_HISTORY_RELATIVE_PATH)}`,
      });
      const snapshot = async () =>
        JSON.stringify([
          (await raw.execute('SELECT key, value FROM meta ORDER BY key')).rows,
          (await raw.execute('SELECT * FROM sessions ORDER BY instance_id'))
            .rows,
          (await raw.execute('SELECT * FROM messages ORDER BY session_id, ord'))
            .rows,
        ]);
      try {
        await raw.execute({
          sql: 'UPDATE meta SET value = ? WHERE key = ?',
          args: ['99', key],
        });
        const before = await snapshot();

        const config = klexConfigSchema.parse({});
        const history = createSessionHistory({
          logging: logger,
          dataDirectory: first.directory,
          config: { get: () => config },
        });
        modules.push(history);
        await expect(history.start()).rejects.toThrow();
        expect(await snapshot()).toBe(before);
      } finally {
        raw.close();
      }
    },
  );

  it('can start again after a failed start', async () => {
    const first = await setup();
    await first.history.close();

    // Hold the write lock so the startup recovery UPDATE fails.
    const blocker = createClient({
      url: `file:${join(first.directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    await blocker.execute('BEGIN EXCLUSIVE');
    const config = klexConfigSchema.parse({});
    const history = createSessionHistory({
      logging: logger,
      dataDirectory: first.directory,
      config: { get: () => config },
    });
    modules.push(history);
    try {
      await expect(history.start()).rejects.toThrow();
    } finally {
      await blocker.execute('ROLLBACK');
      blocker.close();
    }

    await history.start();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
  });
});

describe('session history size cap', () => {
  function bulky(id: string): ExtendedUIMessage {
    return message(id, 'x'.repeat(1_000));
  }

  it('evicts ended sessions before trimming live ones', async () => {
    const { history, setMaxBytes } = await setup();
    const ended = history.openRecorder(meta({ kind: 'child', sessionId: 'c' }));
    ended.scheduleSync(() => [bulky('e1'), bulky('e2')]);
    await ended.end('closed');
    const live = history.openRecorder(meta());
    live.scheduleSync(() => [bulky('l1'), bulky('l2')]);
    await history.flush();

    const liveBytes =
      (await history.getSession(live.instanceId))?.byteSize ?? 0;
    setMaxBytes(Math.ceil(liveBytes / 0.9) + 10);
    await history.enforceSizeCap();

    expect(await history.getSession(ended.instanceId)).toBeUndefined();
    expect(await storedIds(history, live.instanceId)).toEqual(['l1', 'l2']);
  });

  it('trims live messages oldest first and never restores trimmed rows', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [bulky('a'), bulky('b'), bulky('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const bytes = (await history.getSession(recorder.instanceId))?.byteSize;
    // Room for one message after eviction to 90% of the cap.
    setMaxBytes(Math.ceil(((bytes ?? 0) / 3 + 10) / 0.9));
    await history.enforceSizeCap();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['c']);
    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({ trimmedMessageCount: 2, messageCount: 3 });

    setMaxBytes(DEFAULT_SESSION_HISTORY_MAX_BYTES);
    // A mid-window insert takes the next `ord`; known rows that now follow
    // it move to fresh `ord`s. Evicted rows (`b`) stay evicted.
    messages.splice(1, 0, bulky('x'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(
      page?.messages.map((entry) => [entry.seq, entry.message.id]),
    ).toEqual([
      [3, 'x'],
      [5, 'c'],
    ]);
    expect(page?.trimmedMessageCount).toBe(2);
  });

  it('trims the newest live message when it alone exceeds the cap', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [bulky('a'), bulky('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    setMaxBytes(1);
    await history.enforceSizeCap();
    expect(await storedIds(history, recorder.instanceId)).toEqual([]);
    expect(await history.getSession(recorder.instanceId)).toMatchObject({
      trimmedMessageCount: 2,
      messageCount: 2,
      byteSize: 0,
    });

    // New messages are recorded again once there is room.
    setMaxBytes(DEFAULT_SESSION_HISTORY_MAX_BYTES);
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['c']);
  });

  it('reclaims pages with incremental vacuum', async () => {
    const { directory, history, setMaxBytes } = await setup();
    for (let index = 0; index < 5; index++) {
      const recorder = history.openRecorder(meta({ kind: 'child' }));
      recorder.scheduleSync(() =>
        Array.from({ length: 20 }, (_, n) => bulky(`${index}-${n}`)),
      );
      await recorder.end('closed');
    }
    const client = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const pagesBefore = Number(
        (await client.execute('PRAGMA page_count')).rows[0]?.page_count,
      );
      setMaxBytes(1);
      await history.enforceSizeCap();
      const pagesAfter = Number(
        (await client.execute('PRAGMA page_count')).rows[0]?.page_count,
      );
      const freelist = Number(
        (await client.execute('PRAGMA freelist_count')).rows[0]?.freelist_count,
      );
      expect(pagesAfter).toBeLessThan(pagesBefore);
      expect(freelist).toBe(0);
    } finally {
      client.close();
    }
  });
});

function header(id: string, summary = 'summary'): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: CHECKPOINT_PART_TYPE, data: { summary } }],
  } as unknown as ExtendedUIMessage;
}

async function windowIds(history: SessionHistory, sessionId = 'default') {
  const window = await history.loadWindow(sessionId, {
    fallbackMaxBytes: 1024 * 1024,
  });
  return window.entries.map((entry) => entry.message.id);
}

describe('session history log', () => {
  it('continues ord across instances of the same logical session', async () => {
    const { history } = await setup();
    const first = history.openRecorder(meta());
    first.scheduleSync(() => [message('a'), message('b', 'b', 'assistant')]);
    await first.end('replaced');
    const second = history.openRecorder(meta());
    second.scheduleSync(() => [message('c')]);
    await history.flush();

    const page = await history.getMessages(second.instanceId, { limit: 10 });
    expect(page?.messages.map((entry) => entry.seq)).toEqual([2]);
    expect(await windowIds(history)).toEqual(['a', 'b', 'c']);
  });

  it('deletes rolled-back messages but keeps trimmed ones', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    // Rollback: removed without a trim announcement.
    messages.pop();
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);

    // Trim: announced, so the row stays in the log.
    recorder.markTrimmed(['a']);
    messages.shift();
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);
    expect((await history.getSession(recorder.instanceId))?.messageCount).toBe(
      2,
    );
  });

  it('commits a checkpoint and restores header plus tail', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [
      message('a'),
      message('b', 'b', 'assistant'),
      message('c'),
      message('d', 'd', 'assistant'),
    ];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const checkpoint = header('h1');
    await recorder.commitCheckpoint(checkpoint, 'b', () => messages);
    recorder.markTrimmed(['a', 'b']);
    messages.splice(0, 2, checkpoint);
    messages.push(message('e'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    // The header is not re-inserted and trimmed rows stay in the log.
    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'h1',
      'e',
    ]);
    const window = await history.loadWindow('default', {
      fallbackMaxBytes: 1,
    });
    expect(window.hasCheckpoint).toBe(true);
    expect(window.entries.map((entry) => entry.message.id)).toEqual([
      'h1',
      'c',
      'd',
      'e',
    ]);
    expect(window.entries[0]?.isCheckpoint).toBe(true);
  });

  it('rejects a checkpoint whose anchor is not in the window', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b')];
    await expect(
      recorder.commitCheckpoint(header('h1'), 'missing', () => messages),
    ).rejects.toThrow(/not persisted/);
    expect(await windowIds(history)).toEqual(['a', 'b']);
  });

  it('seeds a restored window without re-inserting it', async () => {
    const first = await setup();
    const old = first.history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    old.scheduleSync(() => messages);
    const checkpoint = header('h1');
    await old.commitCheckpoint(checkpoint, 'a', () => messages);
    await old.end('closed');
    await first.history.close();

    const second = await setup({ directory: first.directory });
    const window = await second.history.loadWindow('default', {
      fallbackMaxBytes: 1,
    });
    const recorder = second.history.openRecorder(meta());
    recorder.seed(window);
    const restored = window.entries.map((entry) => entry.message);
    restored.push(message('d'));
    recorder.scheduleSync(() => restored);
    await second.history.flush();

    expect(await storedIds(second.history, recorder.instanceId)).toEqual(['d']);
    expect(await storedIds(second.history, old.instanceId)).toEqual([
      'a',
      'b',
      'c',
      'h1',
    ]);
    expect(await windowIds(second.history)).toEqual(['h1', 'b', 'c', 'd']);

    const oldCount = async () =>
      (await second.history.getSession(old.instanceId))?.messageCount;
    expect(await oldCount()).toBe(4);

    // Rolling back a restored message deletes the old instance's row and
    // keeps that instance's count in step.
    restored.splice(1, 1);
    recorder.scheduleSync(() => restored);
    await second.history.flush();
    expect(await windowIds(second.history)).toEqual(['h1', 'c', 'd']);
    expect(await oldCount()).toBe(3);
    expect(
      (await second.history.getSession(recorder.instanceId))?.messageCount,
    ).toBe(1);
  });

  it('falls back to the newest messages within the byte budget', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [
      message('a', 'x'.repeat(500)),
      message('b', 'x'.repeat(500), 'assistant'),
      message('c', 'x'.repeat(500), 'assistant'),
      message('d', 'x'.repeat(500)),
      message('e', 'x'.repeat(500), 'assistant'),
    ];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const window = await history.loadWindow('default', {
      fallbackMaxBytes: 2_000,
    });
    // Budget fits c, d, e; the window starts at the first user message.
    expect(window.hasCheckpoint).toBe(false);
    expect(window.entries.map((entry) => entry.message.id)).toEqual(['d', 'e']);
  });

  it('never evicts the protected default-session window', async () => {
    const { history, setMaxBytes } = await setup();
    const old = history.openRecorder(meta());
    const messages = [bulkyMessage('a'), bulkyMessage('b'), bulkyMessage('c')];
    old.scheduleSync(() => messages);
    await old.commitCheckpoint(header('h1'), 'a', () => messages);
    await old.end('replaced');
    const child = history.openRecorder(
      meta({ kind: 'child', sessionId: 'child' }),
    );
    child.scheduleSync(() => [bulkyMessage('x')]);
    await child.end('closed');

    setMaxBytes(1);
    await history.enforceSizeCap();

    expect(await history.getSession(child.instanceId)).toBeUndefined();
    expect(await storedIds(history, old.instanceId)).toEqual(['b', 'c', 'h1']);
    expect(await windowIds(history)).toEqual(['h1', 'b', 'c']);
  });
});

function bulkyMessage(id: string): ExtendedUIMessage {
  return message(id, 'x'.repeat(1_000));
}

describe('session history v1 migration', () => {
  const V1_INIT_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_instance_id TEXT,
  extension_identifier TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  trimmed_message_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  persisted_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);
`;
  const V1_DEFINITION: SqliteStoreDefinition = {
    ...SESSION_HISTORY_STORE_DEFINITION,
    schemaVersion: 1,
    compatibilityVersion: 1,
    minimumKlexVersion: '0.14.0',
    initSql: V1_INIT_SQL,
    migrations: [],
    validate: async () => {},
  };

  it('backfills ord per logical session and converts legacy summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-session-history-'));
    directories.push(directory);
    await createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: KLEX_VERSION,
      stores: [V1_DEFINITION],
    }).start();

    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    const sessions: [string, string, string, string][] = [
      // instance, session, kind, created_at (out of insertion order)
      ['i2', 'default', 'default', '2026-01-02T00:00:00.000Z'],
      ['i1', 'default', 'default', '2026-01-01T00:00:00.000Z'],
      ['c1', 'child-1', 'child', '2026-01-01T12:00:00.000Z'],
    ];
    const rows: [string, number, string, string, string][] = [
      ['i1', 0, 'a', 'user', JSON.stringify(message('a'))],
      [
        'i1',
        1,
        'b',
        'assistant',
        JSON.stringify(message('b', 'b', 'assistant')),
      ],
      [
        'i1',
        2,
        's',
        'assistant',
        JSON.stringify({
          id: 's',
          role: 'assistant',
          parts: [{ type: CHECKPOINT_PART_TYPE, data: { summary: 'old' } }],
        }),
      ],
      ['i1', 3, 'c', 'user', JSON.stringify(message('c'))],
      ['i2', 0, 'd', 'user', JSON.stringify(message('d'))],
      ['c1', 0, 'x', 'user', JSON.stringify(message('x'))],
    ];
    try {
      for (const [instanceId, sessionId, kind, createdAt] of sessions) {
        await raw.execute({
          sql: `INSERT INTO sessions (instance_id, session_id, kind, name, created_at, updated_at, ended_at)
                VALUES (?, ?, ?, 'n', ?, ?, ?)`,
          args: [instanceId, sessionId, kind, createdAt, createdAt, createdAt],
        });
      }
      for (const [instanceId, seq, id, role, content] of rows) {
        await raw.execute({
          sql: `INSERT INTO messages (instance_id, seq, message_id, role, content, byte_size, persisted_at)
                VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
          args: [instanceId, seq, id, role, content, content.length],
        });
      }
    } finally {
      raw.close();
    }

    const { history } = await setup({ directory });
    const migrated = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const result = await migrated.execute(
        `SELECT session_id, ord, message_id, is_checkpoint, covers_through_ord
         FROM messages ORDER BY session_id, ord`,
      );
      expect(
        result.rows.map((row) => [
          row.session_id,
          Number(row.ord),
          row.message_id,
          Number(row.is_checkpoint),
          row.covers_through_ord === null
            ? null
            : Number(row.covers_through_ord),
        ]),
      ).toEqual([
        ['child-1', 0, 'x', 0, null],
        ['default', 0, 'a', 0, null],
        ['default', 1, 'b', 0, null],
        ['default', 2, 's', 1, 1],
        ['default', 3, 'c', 0, null],
        ['default', 4, 'd', 0, null],
      ]);
      const header = await migrated.execute(
        `SELECT role, content, byte_size FROM messages WHERE message_id = 's'`,
      );
      const row = header.rows[0];
      expect(row?.role).toBe('user');
      expect(JSON.parse(String(row?.content)).role).toBe('user');
      expect(Number(row?.byte_size)).toBe(
        Buffer.byteLength(String(row?.content)),
      );
    } finally {
      migrated.close();
    }
    expect(await windowIds(history)).toEqual(['s', 'c', 'd']);

    // New writes continue after the migrated log.
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('e')]);
    await history.flush();
    const page = await history.getMessages(recorder.instanceId, { limit: 1 });
    expect(page?.messages[0]?.seq).toBe(5);
  });
});

describe('session history reads', () => {
  it('pages sessions newest first with filters', async () => {
    const { history } = await setup();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const recorder = history.openRecorder(
        meta({
          kind: index === 4 ? 'god' : 'default',
          createdAt: new Date(base + index * 1000).toISOString(),
        }),
      );
      recorder.scheduleSync(() => [message(`m${index}`)]);
      ids.push(recorder.instanceId);
    }
    await history.flush();

    const first = await history.listSessions({ kind: 'default', limit: 2 });
    expect(first.sessions.map((session) => session.instanceId)).toEqual([
      ids[3],
      ids[2],
    ]);
    expect(first.hasMore).toBe(true);
    const second = await history.listSessions({
      kind: 'default',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.sessions.map((session) => session.instanceId)).toEqual([
      ids[1],
      ids[0],
    ]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });

    const main = await history.listSessions({
      kind: 'default',
      live: true,
      limit: 1,
    });
    expect(main.sessions[0]?.instanceId).toBe(ids[3]);

    await expect(
      history.listSessions({ limit: 1, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidSessionHistoryCursorError);
  });

  it('filters children by parent instance', async () => {
    const { history } = await setup();
    const parent = history.openRecorder(meta());
    const child = history.openRecorder(
      meta({ kind: 'child', parentInstanceId: parent.instanceId }),
    );
    parent.scheduleSync(() => [message('p')]);
    child.scheduleSync(() => [message('c')]);
    await history.flush();
    const page = await history.listSessions({
      parentInstanceId: parent.instanceId,
      limit: 10,
    });
    expect(page.sessions.map((session) => session.instanceId)).toEqual([
      child.instanceId,
    ]);
  });

  it('pages messages backwards in chronological order', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = Array.from({ length: 5 }, (_, index) =>
      message(`m${index}`),
    );
    recorder.scheduleSync(() => messages);
    await history.flush();

    const newest = await history.getMessages(recorder.instanceId, { limit: 2 });
    expect(newest?.messages.map((entry) => entry.message.id)).toEqual([
      'm3',
      'm4',
    ]);
    expect(newest).toMatchObject({ hasMore: true, nextCursor: 3 });
    const older = await history.getMessages(recorder.instanceId, {
      limit: 10,
      beforeSeq: newest?.nextCursor ?? undefined,
    });
    expect(older?.messages.map((entry) => entry.message.id)).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
    expect(older).toMatchObject({ hasMore: false, nextCursor: null });
    expect(await history.getMessages('unknown', { limit: 1 })).toBeUndefined();
  });
});
