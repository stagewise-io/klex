import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConfig } from '@/config';
import { createDirectoryLock } from '@/directory-lock';
import { createLocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';
import { KLEX_VERSION } from '@/release';

import { createAgentDirectory } from './agent-directory';

const roots: string[] = [];
const logging = {
  child: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as never;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'klex-agents-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AgentDirectory', () => {
  it('creates an agent config that is immediately discoverable', async () => {
    const root = await makeRoot();
    const directory = createAgentDirectory({ logging, rootDirectory: root });

    const created = await directory.create('Ada');

    expect(created.officialName).toBe('Ada');
    expect(created.inUse).toBe(false);
    expect(await directory.discover()).toEqual([created]);
    expect(
      JSON.parse(
        await readFile(join(created.directory, 'config.json'), 'utf8'),
      ),
    ).toMatchObject({
      _klex: {
        store: 'config',
        schemaVersion: 10,
        compatibilityVersion: 8,
      },
      configVersion: 2,
      officialName: 'Ada',
      providers: {},
      modelSelection: {
        chat: [],
        compaction: [],
        memory: [],
        imageVision: [],
        audioListening: [],
        instincts: [],
        voice: { sts: [] },
      },
      mcpServers: {},
      extensions: {
        memory: {
          episodes: {
            maxCharacters: 50_000,
            maxDurationMs: 3_600_000,
            idleTimeoutMs: 600_000,
          },
        },
      },
    });
    const stored = JSON.parse(
      await readFile(join(created.directory, 'config.json'), 'utf8'),
    );
    expect(stored.instinct).toMatchObject({ enabled: true, timeoutMs: 8_000 });
    expect(stored).not.toHaveProperty('preflight');
    expect(stored).not.toHaveProperty('episodeFinishIdleTriggerTimeMs');
    expect(stored).not.toHaveProperty('memoryWriteIntervalMs');
    expect(stored).not.toHaveProperty('memoryWriteStepInterval');
  });

  it('creates unique UUID folders for unnamed cloud agents and loads them through registered startup', async () => {
    const root = await makeRoot();
    const directory = createAgentDirectory({ logging, rootDirectory: root });
    const first = await directory.create();
    const second = await directory.create();
    expect(basename(first.directory)).toMatch(
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
    );
    expect(first.directory).not.toBe(second.directory);
    expect(first.officialName).toBe('Bot');
    const lock = createDirectoryLock({
      logging,
      dataDirectory: first.directory,
    });
    const localData = createLocalData({
      logging,
      dataDirectory: first.directory,
      klexVersion: KLEX_VERSION,
      stores: KLEX_LOCAL_DATA_STORES,
    });
    const config = createConfig({ logging, dataDirectory: first.directory });
    await lock.acquire();
    try {
      await localData.start();
      await config.start();
      expect(config.get().officialName).toBe('Bot');
      await config.mutate((current) => ({
        ...current,
        officialName: 'Cloud name',
      }));
      expect(await directory.discover()).toContainEqual(
        expect.objectContaining({
          directory: first.directory,
          officialName: 'Cloud name',
        }),
      );
    } finally {
      await config.close();
      await localData.close();
      await lock.release();
    }
  });

  it('rejects invalid local names and never overwrites an existing agent', async () => {
    const root = await makeRoot();
    const directory = createAgentDirectory({ logging, rootDirectory: root });
    for (const name of ['', 'A', '..', '../Ada', 'a/b', 'a\\\\b']) {
      await expect(directory.create(name)).rejects.toThrow('Bot name');
    }
    const agent = await directory.create('Ada');
    const before = await readFile(join(agent.directory, 'config.json'), 'utf8');
    await expect(directory.create('Ada')).rejects.toThrow('Could not create');
    expect(await readFile(join(agent.directory, 'config.json'), 'utf8')).toBe(
      before,
    );
  });

  it('marks agents whose directory lock is held as in use', async () => {
    const root = await makeRoot();
    const directory = createAgentDirectory({ logging, rootDirectory: root });
    const created = await directory.create('Running Agent');
    const lock = createDirectoryLock({
      logging,
      dataDirectory: created.directory,
    });
    await lock.acquire();

    try {
      expect((await directory.discover())[0]?.inUse).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('only discovers first-level directories with valid official names', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'not-a-directory.json'), '{}');
    await mkdir(join(root, 'valid'), { recursive: true });
    await writeFile(
      join(root, 'valid', 'config.json'),
      JSON.stringify({
        _klex: {
          store: 'config',
          schemaVersion: 1,
          compatibilityVersion: 1,
          minimumKlexVersion: '0.3.0',
          writtenByKlexVersion: '0.3.0',
        },
        officialName: '  Valid  ',
        providers: {},
        modelSelection: {
          chat: [],
          compaction: [],
          memory: [],
          imageVision: [],
          audioListening: [],
          voice: { sts: [] },
        },
        mcpServers: {},
      }),
    );
    await mkdir(join(root, 'legacy'), { recursive: true });
    await writeFile(join(root, 'legacy', 'config.json'), '{}');
    await mkdir(join(root, 'invalid'), { recursive: true });
    await writeFile(
      join(root, 'invalid', 'config.json'),
      JSON.stringify({ officialName: 'A' }),
    );

    const agents = await createAgentDirectory({
      logging,
      rootDirectory: root,
    }).discover();

    expect(agents.map((agent) => agent.officialName)).toEqual([
      'A',
      'legacy',
      'Valid',
    ]);
    expect(agents.filter((agent) => agent.compatibilityError)).toHaveLength(1);
    expect(
      agents.find((agent) => agent.officialName === 'legacy')
        ?.compatibilityError,
    ).toBeUndefined();
  });
});
