import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDirectoryLock } from '@/directory-lock';

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
        schemaVersion: 1,
        compatibilityVersion: 1,
      },
      officialName: 'Ada',
      providers: {},
      modelSelection: { chat: [] },
    });
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
          voice: { sts: [], tts: [], stt: [] },
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
