import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  createModelCallLogger,
  MODEL_CALL_STORE_DEFINITION,
} from '@/model-call-logger';
import { KLEX_VERSION } from '@/release';
import {
  createLearningState,
  LEARNING_STATE_STORE_DEFINITION,
} from '@/session/chat/extensions/learning/learning-state';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
} from '@/session-history';

import { createLocalData } from './local-data';
import type { SqliteStoreDefinition } from './types';

const fixtures = new URL('../local-data-migration-fixtures/', import.meta.url);
const directories: string[] = [];
const logging = createLogger({ name: 'frozen-upgrades' });

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'klex-frozen-stores-'));
  directories.push(path);
  return path;
}

async function snapshot(path: string) {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        // After clients close, SQLite may still remove live WAL/SHM sidecars.
        // Compare database/checkpoint files, excluding only top-level sidecars.
        .filter(
          (entry) =>
            entry.isFile() &&
            !(
              entry.parentPath === path &&
              /\.sqlite-(wal|shm)$/.test(entry.name)
            ),
        )
        .map(async (entry) => {
          const file = join(entry.parentPath, entry.name);
          return [
            file,
            {
              bytes: (await readFile(file)).toString('base64'),
              mtime: (await stat(file)).mtimeMs,
            },
          ];
        }),
    ),
  );
}

async function seedSqlite(path: string, fixture: string) {
  const client = createClient({ url: `file:${path}` });
  try {
    // PRAGMAs are deliberately executed separately: executeMultiple skips some.
    await client.execute('PRAGMA auto_vacuum = INCREMENTAL');
    await client.executeMultiple(
      await readFile(new URL(fixture, fixtures), 'utf8'),
    );
  } finally {
    client.close();
  }
}

async function assertSqliteMetadata(
  path: string,
  store: SqliteStoreDefinition,
) {
  const client = createClient({ url: `file:${path}` });
  try {
    const result = await client.execute('SELECT key, value FROM meta');
    expect(
      Object.fromEntries(result.rows.map((row) => [row.key, row.value])),
    ).toEqual({
      store: store.id,
      schemaVersion: String(store.schemaVersion),
      compatibilityVersion: String(store.compatibilityVersion),
      minimumKlexVersion: store.minimumKlexVersion,
      writtenByKlexVersion: KLEX_VERSION,
    });
  } finally {
    client.close();
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('frozen SQLite upgrades', () => {
  for (const store of [
    MODEL_CALL_STORE_DEFINITION,
    SESSION_HISTORY_STORE_DEFINITION,
  ]) {
    it.each([1, 2])(
      `loads ${store.id} v%s through registered startup and its owner`,
      async (version) => {
        const dataDirectory = await directory();
        const path = join(dataDirectory, store.relativePath);
        await seedSqlite(path, `${store.id}-v${version}.sql`);
        const start = async () => {
          const localData = createLocalData({
            logging,
            dataDirectory,
            klexVersion: KLEX_VERSION,
            stores: [store],
          });
          await localData.start();
          try {
            if (store.id === 'model-calls') {
              const owner = createModelCallLogger({ logging, dataDirectory });
              await owner.start();
              try {
                const calls = await owner.queryUsage({
                  splitBy: 'none',
                  from: null,
                  to: null,
                  granularity: 'event',
                  limit: 10,
                });
                expect(calls).toHaveLength(1);
                expect(calls[0]).toMatchObject({
                  id: 'call-frozen',
                  sessionId: 'default',
                  providerId: 'primary',
                  modelId: 'gpt-4o',
                  inputTokens: 123,
                  outputTokens: 45,
                  inputCacheWriteTokens: 6,
                  inputCacheReadTokens: 7,
                  callCount: 1,
                });
              } finally {
                await owner.close();
              }
            } else {
              const config = JSON.parse(
                await readFile(
                  new URL('config-expected-v7.json', fixtures),
                  'utf8',
                ),
              );
              const owner = createSessionHistory({
                logging,
                dataDirectory,
                config: { get: () => config },
              });
              await owner.start();
              try {
                expect(await owner.getSession('instance-frozen')).toMatchObject(
                  {
                    sessionId: 'default',
                    name: 'Frozen session',
                    generationError: null,
                    messageCount: 2,
                  },
                );
                const page = await owner.getMessages('instance-frozen', {
                  limit: 10,
                });
                expect(page?.messages.map((item) => item.message)).toEqual([
                  {
                    id: 'user-frozen',
                    role: 'user',
                    parts: [{ type: 'text', text: 'hello' }],
                  },
                  {
                    id: 'summary-frozen',
                    role: 'user',
                    parts: [
                      {
                        type: 'data-context-summary',
                        data: { summary: 'remember hello' },
                      },
                    ],
                  },
                ]);
                const client = createClient({ url: `file:${path}` });
                try {
                  const result = await client.execute(
                    'SELECT ord, is_checkpoint, covers_through_ord FROM messages ORDER BY ord',
                  );
                  expect(result.rows).toMatchObject([
                    { ord: 0, is_checkpoint: 0, covers_through_ord: null },
                    { ord: 1, is_checkpoint: 1, covers_through_ord: 0 },
                  ]);
                } finally {
                  client.close();
                }
              } finally {
                await owner.close();
              }
            }
          } finally {
            await localData.close();
          }
        };
        await start();
        await assertSqliteMetadata(path, store);
        const beforeRestart = await snapshot(dataDirectory);
        await start();
        expect(await snapshot(dataDirectory)).toEqual(beforeRestart);
      },
    );
  }
});

describe('frozen learning-state upgrades', () => {
  it.each([1, 2])(
    'loads v%s through registered startup and its owner without rewriting on restart',
    async (version) => {
      const dataDirectory = await directory();
      const path = join(
        dataDirectory,
        LEARNING_STATE_STORE_DEFINITION.relativePath,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        await readFile(new URL(`learning-v${version}.json`, fixtures)),
      );
      const {
        _klex: _metadata,
        futureField: _unknown,
        ...expected
      } = JSON.parse(
        await readFile(new URL('learning-v2.json', fixtures), 'utf8'),
      );
      const start = async () => {
        const localData = createLocalData({
          logging,
          dataDirectory,
          klexVersion: KLEX_VERSION,
          stores: [LEARNING_STATE_STORE_DEFINITION],
        });
        await localData.start();
        try {
          const owner = createLearningState(dirname(path));
          await owner.start();
          expect(owner.get()).toEqual({
            ...expected,
            skills: {
              research: { ...expected.skills.research, userEdited: false },
            },
          });
        } finally {
          await localData.close();
        }
      };
      await start();
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        futureField: { preserve: true },
        skills: { research: { futureSkillField: 'keep' } },
        _klex: {
          store: 'learning-extension-state',
          schemaVersion: 2,
          compatibilityVersion: 3,
          minimumKlexVersion: '0.28.0',
        },
      });
      const beforeRestart = await snapshot(dataDirectory);
      await start();
      expect(await snapshot(dataDirectory)).toEqual(beforeRestart);
    },
  );
});
