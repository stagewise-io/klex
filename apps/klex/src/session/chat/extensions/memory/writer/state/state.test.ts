import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';

import { createEntityStore } from '../entities';
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
    klexVersion: '0.38.1',
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
      compatibilityVersion: 3,
      minimumKlexVersion: '0.38.1',
    });
  });
  it.each([1, 2])(
    'raises compatibility %s of existing state before converting notes',
    async (compatibilityVersion) => {
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
            compatibilityVersion,
            minimumKlexVersion:
              compatibilityVersion === 1 ? '0.33.0' : '0.37.1',
            writtenByKlexVersion: '0.38.0',
          },
        }),
      );
      const entitiesRoot = join(dirname(file), 'entities');
      const entityFile = join(entitiesRoot, 'person/Alex Smith.md');
      await mkdir(dirname(entityFile), { recursive: true });
      await writeFile(
        entityFile,
        '---\nFormatVersion: 5\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities: []\nLoadOn: []\nRelatedTo:\n  - "[[project/Klex|works on (80)]]"\nTrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\n- Engineer [old](history:abc)\n',
      );
      await startup(root);
      const entities = createEntityStore(entitiesRoot);
      await entities.start();
      expect(entities.get('person/Alex Smith')?.frontmatter.RelatedTo).toEqual([
        {
          target: { kind: 'entity', id: 'project/Klex' },
          relationship: 'relatedTo',
        },
      ]);
      const note = await readFile(entityFile, 'utf8');
      expect(note).toContain('FormatVersion: 6');
      const upgraded = JSON.parse(await readFile(file, 'utf8'));
      expect(upgraded.cursor).toBe('history:cursor');
      expect(upgraded._klex).toMatchObject({
        compatibilityVersion: 3,
        minimumKlexVersion: '0.38.1',
      });
      const before = await readFile(file, 'utf8');
      await startup(root);
      expect(await readFile(file, 'utf8')).toBe(before);
      const oldReader = createLocalData({
        logging,
        dataDirectory: root,
        klexVersion: '0.38.0',
        stores: [
          {
            ...MEMORY_WRITER_STORE_DEFINITION,
            compatibilityVersion: 2,
            minimumKlexVersion: '0.37.1',
          },
        ],
      });
      try {
        await expect(oldReader.start()).rejects.toThrow();
      } finally {
        await oldReader.close();
      }
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(await readFile(entityFile, 'utf8')).toBe(note);
      const restarted = createEntityStore(entitiesRoot);
      await restarted.start();
      expect(await readFile(entityFile, 'utf8')).toBe(note);
    },
  );
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
