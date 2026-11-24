import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

import { SKILL_REGISTRY_STORE_DEFINITION } from './registry-store';
import { createSkillRegistry } from './skills';

const directories: string[] = [];
const logging = createLogger({ name: 'event-matcher-migration' });
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it('renames only event matchers through registered startup, preserves metadata, restarts and rejects old writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-matcher-migration-'));
  directories.push(directory);
  const file = join(directory, 'skills/registry.json');
  await mkdir(join(directory, 'skills/learning/example'), { recursive: true });
  await writeFile(
    join(directory, 'skills/learning/example/SKILL.md'),
    '---\nname: example\ndescription: Example procedure\n---\nRun verification.\n',
  );
  const old = {
    turn: 7,
    future: { preserved: true },
    skills: {
      'learning/example': {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastReadAt: null,
        readCount: 0,
        createdTurn: 1,
        updatedTurn: 1,
        lastReadTurn: null,
        userEdited: true,
        future: 'kept',
        metadata: {
          unrelated: { env: '${KEEP}' },
          loadOn: [
            {
              type: 'pushNotificationMetadataPattern',
              server: 'slack',
              conditions: [{ path: 'userId', match: 'exact', value: 'U1' }],
            },
            { type: 'contentPattern', pattern: 'example' },
          ],
        },
      },
    },
    _klex: {
      store: 'skill-registry',
      schemaVersion: 1,
      compatibilityVersion: 1,
      minimumKlexVersion: '0.28.0',
      writtenByKlexVersion: '0.38.0',
    },
  };
  await writeFile(file, JSON.stringify(old));
  const start = (stores = [SKILL_REGISTRY_STORE_DEFINITION]) =>
    createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: '0.38.2',
      stores,
    }).start();
  await expect(
    start([
      {
        ...SKILL_REGISTRY_STORE_DEFINITION,
        migrations: [
          {
            ...LOCAL_DATA_MIGRATIONS['skill-registry'].migrations[0]!,
            up() {
              throw new Error('injected migration failure');
            },
          },
        ],
      },
    ]),
  ).rejects.toThrow(/original data was restored/);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(old);
  await start();
  const bytes = await readFile(file, 'utf8');
  const next = JSON.parse(bytes);
  expect(next).toMatchObject({
    ...old,
    _klex: {
      schemaVersion: 2,
      compatibilityVersion: 2,
      minimumKlexVersion: '0.38.2',
      writtenByKlexVersion: '0.38.2',
    },
    skills: {
      'learning/example': {
        ...old.skills['learning/example'],
        metadata: {
          ...old.skills['learning/example'].metadata,
          loadOn: [
            {
              ...old.skills['learning/example'].metadata.loadOn[0],
              type: 'eventDataPattern',
            },
            old.skills['learning/example'].metadata.loadOn[1],
          ],
        },
      },
    },
  });
  await start();
  expect(await readFile(file, 'utf8')).toBe(bytes);
  const registry = createSkillRegistry({
    dataDirectory: directory,
    logger: logging,
  });
  await registry.start();
  expect((await registry.snapshot())[0]?.metadata.loadOn).toEqual(
    next.skills['learning/example'].metadata.loadOn,
  );
  await expect(
    start([
      {
        ...SKILL_REGISTRY_STORE_DEFINITION,
        schemaVersion: 1,
        compatibilityVersion: 1,
        minimumKlexVersion: '0.28.0',
        versions: LOCAL_DATA_MIGRATIONS['skill-registry'].versions.slice(0, 1),
        migrations: [],
      },
    ]),
  ).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(bytes);
});

it.each(['invalid', 'newer'])(
  'leaves %s registry bytes unchanged during preflight',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'event-matcher-invalid-'));
    directories.push(directory);
    await mkdir(join(directory, 'skills'));
    const file = join(directory, 'skills/registry.json');
    const bytes = JSON.stringify({
      turn: kind === 'invalid' ? -1 : 0,
      skills: {},
      _klex: {
        store: 'skill-registry',
        schemaVersion: kind === 'newer' ? 3 : 1,
        compatibilityVersion: 1,
        minimumKlexVersion: '0.28.0',
        writtenByKlexVersion: '0.38.0',
      },
    });
    await writeFile(file, bytes);
    await expect(
      createLocalData({
        logging,
        dataDirectory: directory,
        klexVersion: '0.38.2',
        stores: [SKILL_REGISTRY_STORE_DEFINITION],
      }).start(),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(bytes);
  },
);
