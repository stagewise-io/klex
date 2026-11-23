import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';

import { createWriterState, MEMORY_WRITER_STORE_DEFINITION } from './state';

const directories: string[] = [];
const logging = createLogger({ name: 'writer-state-test' });
const store = KLEX_LOCAL_DATA_STORES.find(
  (definition) => definition.id === 'memory-writer-state',
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'writer-state-'));
  directories.push(root);
  const file = join(root, MEMORY_WRITER_STORE_DEFINITION.relativePath);
  await mkdir(dirname(file), { recursive: true });
  return { root, file };
}
async function startup(root: string) {
  if (!store) throw new Error('Missing registered writer store');
  const local = createLocalData({
    logging,
    dataDirectory: root,
    klexVersion: '0.33.0',
    stores: [store],
  });
  try {
    await local.start();
  } finally {
    await local.close();
  }
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('registered memory writer state', () => {
  it('creates state after preflight and preserves unknown fields across updates/restarts', async () => {
    const { root, file } = await fixture();
    await startup(root);
    const state = createWriterState(dirname(file));
    await state.start();
    await state.update((draft) => {
      draft.initialized = true;
      draft.cursor = 'history:cursor';
      draft.pendingThrough = 'history:pending';
      draft.future = { keep: true };
    });
    const before = await readFile(file, 'utf8');
    await startup(root);
    await startup(root);
    expect(await readFile(file, 'utf8')).toBe(before);
    const restored = createWriterState(dirname(file));
    await restored.start();
    expect(restored.get()).toMatchObject({
      initialized: true,
      cursor: 'history:cursor',
      pendingThrough: 'history:pending',
      future: { keep: true },
    });
    await restored.update((draft) => {
      draft.cursor = 'history:new';
    });
    expect(restored.get().future).toEqual({ keep: true });
    expect(JSON.parse(await readFile(file, 'utf8'))._klex).toMatchObject({
      schemaVersion: 1,
      compatibilityVersion: 2,
      minimumKlexVersion: '0.37.1',
    });
  });
  it('raises compatibility of existing state so older binaries refuse it', async () => {
    const { root, file } = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        initialized: true,
        cursor: 'history:cursor',
        pendingThrough: null,
        _klex: {
          store: 'memory-writer-state',
          schemaVersion: 1,
          compatibilityVersion: 1,
          minimumKlexVersion: '0.33.0',
          writtenByKlexVersion: '0.37.0',
        },
      }),
    );
    await startup(root);
    const upgraded = JSON.parse(await readFile(file, 'utf8'));
    expect(upgraded.cursor).toBe('history:cursor');
    expect(upgraded._klex).toMatchObject({
      compatibilityVersion: 2,
      minimumKlexVersion: '0.37.1',
    });
    const before = await readFile(file, 'utf8');
    await startup(root);
    expect(await readFile(file, 'utf8')).toBe(before);
    const oldReader = createLocalData({
      logging,
      dataDirectory: root,
      klexVersion: '0.37.0',
      stores: [
        {
          ...MEMORY_WRITER_STORE_DEFINITION,
          compatibilityVersion: 1,
          minimumKlexVersion: '0.33.0',
        },
      ],
    });
    try {
      await expect(oldReader.start()).rejects.toThrow();
    } finally {
      await oldReader.close();
    }
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it.each(['newer', 'invalid'])(
    'rejects %s data before mutation',
    async (kind) => {
      const { root, file } = await fixture();
      const payload = {
        initialized: kind === 'invalid' ? 'not-boolean' : true,
        cursor: null,
        pendingThrough: null,
        _klex: {
          store: 'memory-writer-state',
          schemaVersion: kind === 'newer' ? 2 : 1,
          compatibilityVersion: 1,
          minimumKlexVersion: '0.33.0',
          writtenByKlexVersion: '0.33.0',
        },
      };
      const before = JSON.stringify(payload);
      await writeFile(file, before);
      await expect(startup(root)).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(before);
    },
  );
});
