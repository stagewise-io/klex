import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';

import {
  createLearningState,
  LEARNING_STATE_STORE_DEFINITION,
} from './learning-state';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-learning-state-'));
  directories.push(directory);
  return directory;
}

describe('learning state', () => {
  it('migrates v1 through the registry without inventing activity or losing unknown fields', async () => {
    const dir = await dataDir();
    const path = join(dir, LEARNING_STATE_STORE_DEFINITION.relativePath);
    await mkdir(join(dir, 'extensions/io.stagewise/learning'), {
      recursive: true,
    });
    const old = {
      cursor: '2026-10-06/1-12-00.jsonl',
      episodeFailures: { a: 2 },
      changedRunsSinceConsolidation: 99,
      lastConsolidationAt: '2026-01-01T00:00:00Z',
      future: true,
      skills: {
        x: {
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          lastReadAt: '2026-01-03T00:00:00Z',
          readCount: 5,
          sourceEpisodes: ['a'],
          futureSkill: 'keep',
        },
      },
    };
    await writeFile(
      path,
      JSON.stringify({
        ...old,
        _klex: {
          store: LEARNING_STATE_STORE_DEFINITION.id,
          schemaVersion: 1,
          compatibilityVersion: 1,
          minimumKlexVersion: '0.14.0',
          writtenByKlexVersion: '0.14.0',
        },
      }),
    );
    const options = {
      logging: createLogger({ name: 'learning-migration-test' }),
      dataDirectory: dir,
      klexVersion: '0.14.0',
      stores: [LEARNING_STATE_STORE_DEFINITION],
    };
    await createLocalData(options).start();
    const migrated = await readFile(path, 'utf8');
    await createLocalData(options).start();
    expect(await readFile(path, 'utf8')).toBe(migrated);
    const state = createLearningState(
      join(dir, 'extensions/io.stagewise/learning'),
    );
    await state.start();
    expect(state.get()).toMatchObject({
      cursor: old.cursor,
      episodeFailures: old.episodeFailures,
      changedRunsSinceConsolidation: old.changedRunsSinceConsolidation,
      lastConsolidationAt: old.lastConsolidationAt,
      processedEpisodeCount: 0,
      pendingChangeWeight: 0,
      deferred: [],
      skills: {
        x: {
          ...old.skills.x,
          createdEpisode: 0,
          updatedEpisode: 0,
          lastReadEpisode: null,
        },
      },
    });
    expect(JSON.parse(migrated)).toMatchObject({
      future: true,
      skills: { x: { futureSkill: 'keep' } },
    });
    await state.update(() => undefined);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      future: true,
      skills: { x: { futureSkill: 'keep' } },
    });
    const rewritten = await readFile(path, 'utf8');
    expect(
      LEARNING_STATE_STORE_DEFINITION.versions[0]?.schema.safeParse(state.get())
        .success,
    ).toBe(true);
    await expect(
      createLocalData({
        ...options,
        stores: [
          {
            ...LEARNING_STATE_STORE_DEFINITION,
            schemaVersion: 1,
            versions: LEARNING_STATE_STORE_DEFINITION.versions.slice(0, 1),
            migrations: [],
          },
        ],
      }).start(),
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(rewritten);
  });
  it('defaults when the file is missing', async () => {
    const state = createLearningState(await dataDir());
    await state.start();
    expect(state.get()).toEqual({
      processedEpisodeCount: 0,
      pendingChangeWeight: 0,
      lastConsolidationEpisode: 0,
      lastConsolidationSkillCount: 0,
      consolidationFailures: 0,
      nextConsolidationEpisode: null,
      deferred: [],
      cursor: null,
      episodeFailures: {},
      changedRunsSinceConsolidation: 0,
      lastConsolidationAt: null,
      skills: {},
    });
  });

  it('persists updates and preserves unknown fields', async () => {
    const dir = await dataDir();
    const state = createLearningState(dir);
    await state.update((draft) => {
      draft.cursor = '2026-10-06/1-12-00.jsonl';
    });
    const path = join(dir, 'state.json');
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...raw, future: { a: 1 } }));

    const reloaded = createLearningState(dir);
    await reloaded.update((draft) => {
      draft.changedRunsSinceConsolidation = 2;
    });
    const written = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(written.future).toEqual({ a: 1 });
    expect(written.cursor).toBe('2026-10-06/1-12-00.jsonl');
    expect(written.changedRunsSinceConsolidation).toBe(2);
  });

  it('rejects a newer schema version without mutating the file', async () => {
    const dir = await dataDir();
    await createLearningState(dir).update(() => undefined);
    const path = join(dir, 'state.json');
    const raw = JSON.parse(await readFile(path, 'utf-8')) as {
      _klex: Record<string, unknown>;
    };
    raw._klex.schemaVersion = LEARNING_STATE_STORE_DEFINITION.schemaVersion + 1;
    raw._klex.compatibilityVersion =
      LEARNING_STATE_STORE_DEFINITION.compatibilityVersion + 1;
    const newer = JSON.stringify(raw);
    await writeFile(path, newer);
    await expect(createLearningState(dir).start()).rejects.toThrow();
    expect(await readFile(path, 'utf-8')).toBe(newer);
  });
});
