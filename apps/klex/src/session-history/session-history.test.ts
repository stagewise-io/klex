import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { AdmissionGate, AdmissionRejectedError } from '@/admission';
import { type KlexConfig, klexConfigSchema } from '@/config';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import {
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

async function setup(
  options: {
    maxBytes?: number;
    directory?: string;
    admission?: AdmissionGate;
  } = {},
) {
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
    admission: options.admission,
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
  vi.useRealTimers();
  await Promise.all(modules.splice(0).map((module) => module.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session history admission', () => {
  it('keeps failed enforcement visible until enforcement itself succeeds', async () => {
    const gate = new AdmissionGate();
    const { history, directory, setMaxBytes } = await setup({
      admission: gate,
    });
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    setMaxBytes(1);
    const db = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      await db.execute(
        "CREATE TRIGGER fail_eviction BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'injected eviction failure'); END",
      );
      await history.enforceSizeCap();
      expect((await gate.prepare()).outcome).toBe('aborted');
      recorder.scheduleSync(() => [message('a')]);
      await history.flush();
      expect(gate.status().blockers).toContain(
        'Session history persistence failed',
      );
      await db.execute('DROP TRIGGER fail_eviction');
      await history.enforceSizeCap();
      expect((await gate.prepare()).outcome).toBe('quiescent');
      gate.abort('test complete');
    } finally {
      db.close();
    }
  });

  it('awaits final transcript and end marker in certified teardown', async () => {
    const gate = new AdmissionGate();
    const { history } = await setup({ admission: gate });
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    const result = await gate.prepare();
    if (result.outcome !== 'quiescent') throw new Error('Expected certificate');
    gate.consume(result.lease);
    await recorder.end('closed');
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
    expect(await history.getSession(recorder.instanceId)).toMatchObject({
      live: false,
      endReason: 'closed',
    });
    await history.close();
  });

  it('owns queued and running persistence and blocks certification until committed', async () => {
    const gate = new AdmissionGate();
    const { history } = await setup({ admission: gate });
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => {
      expect(gate.status().activeWork).toBeGreaterThan(0);
      return [message('accepted')];
    });
    expect(gate.status().activeWork).toBe(1);
    expect((await gate.prepare()).outcome).toBe('aborted');
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['accepted']);
    // Use a pure getter for the participant's content check.
    recorder.scheduleSync(() => [message('accepted')]);
    await history.flush();
    expect((await gate.prepare()).outcome).toBe('quiescent');
    gate.abort('test complete');
  });

  it('retains failed DB writes and dirty older content until a successful retry', async () => {
    const gate = new AdmissionGate();
    const { history, directory } = await setup({ admission: gate });
    const db = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      await db.execute(
        "CREATE TRIGGER fail_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
      );
      const recorder = history.openRecorder(meta());
      const original = message('a');
      const messages = [original];
      recorder.scheduleSync(() => messages);
      await history.flush();
      expect(gate.status().blockers).toContain(
        'Session history persistence failed',
      );
      expect((await gate.prepare()).outcome).toBe('aborted');
      await db.execute('DROP TRIGGER fail_history');
      recorder.scheduleSync(() => messages);
      await history.flush();
      expect(gate.status().blockers).toEqual([]);
      original.parts = [{ type: 'text', text: 'repaired' }];
      expect((await gate.prepare()).outcome).toBe('aborted');
      recorder.scheduleSync(() => messages);
      await history.flush();
      expect((await gate.prepare()).outcome).toBe('quiescent');
      gate.abort('test complete');
    } finally {
      db.close();
    }
  });

  it('retains a failed end marker and recovers through end retry', async () => {
    const gate = new AdmissionGate();
    const { history, directory } = await setup({ admission: gate });
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    const db = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      await db.execute(
        "CREATE TRIGGER fail_end BEFORE UPDATE OF ended_at ON sessions BEGIN SELECT RAISE(ABORT, 'injected end failure'); END",
      );
      await recorder.end('closed');
      expect((await gate.prepare()).outcome).toBe('aborted');
      await db.execute('DROP TRIGGER fail_end');
      await recorder.end('closed');
      expect(await history.getSession(recorder.instanceId)).toMatchObject({
        live: false,
      });
      expect((await gate.prepare()).outcome).toBe('quiescent');
      gate.abort('test complete');
    } finally {
      db.close();
    }
  });

  it('defers the enforcement timer during drain and resumes on rollback', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate();
    const { history, setMaxBytes } = await setup({ admission: gate });
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    setMaxBytes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    const work = gate.admitRoot();
    const preparing = gate.prepare();
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.status()).toMatchObject({ state: 'draining', deferredWork: 1 });
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
    gate.abort('rollback');
    work.release();
    expect((await preparing).outcome).toBe('aborted');
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual([]);
  });

  it('revokes a certificate before deferred persistence starts', async () => {
    const gate = new AdmissionGate();
    const { history } = await setup({ admission: gate });
    const recorder = history.openRecorder(meta());
    const result = await gate.prepare();
    if (result.outcome !== 'quiescent') throw new Error('Expected certificate');
    recorder.scheduleSync(() => {
      expect(gate.status().state).toBe('open');
      return [message('late')];
    });
    expect(() => gate.consume(result.lease)).toThrow(AdmissionRejectedError);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['late']);
  });
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
          (
            await raw.execute(
              'SELECT * FROM messages ORDER BY instance_id, seq',
            )
          ).rows,
        ]);
      try {
        await raw.execute({
          sql: 'UPDATE meta SET value = ? WHERE key = ?',
          args: ['2', key],
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

  it('trims live messages oldest first and never rewrites trimmed rows', async () => {
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
    messages.splice(1, 0, bulky('x'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(
      page?.messages.map((entry) => [entry.seq, entry.message.id]),
    ).toEqual([
      [2, 'b'],
      [3, 'c'],
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
