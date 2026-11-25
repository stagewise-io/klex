import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';

import {
  createConsolidatorState,
  MEMORY_CONSOLIDATOR_STORE_DEFINITION,
} from './state';

it('round-trips consolidator state through registered startup without rewriting or losing unknown fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consolidator-state-'));
  const logging = createLogger({ name: 'consolidator-test' });
  const file = join(root, MEMORY_CONSOLIDATOR_STORE_DEFINITION.relativePath);
  const startup = async () => {
    const store = KLEX_LOCAL_DATA_STORES.find(
      (candidate) => candidate.id === 'memory-consolidator-state',
    );
    if (!store) throw new Error('Missing registered consolidator store');
    const local = createLocalData({
      logging,
      dataDirectory: root,
      klexVersion: '0.39.0',
      stores: [store],
    });
    try {
      await local.start();
    } finally {
      await local.close();
    }
  };
  try {
    await startup();
    const state = createConsolidatorState(dirname(file));
    await state.start();
    await Promise.all([
      state.update((draft) => {
        draft.lastRunAt = '2026-11-25T10:00:00.000Z';
        draft.future = { keep: true };
      }),
      state.update((draft) => {
        draft.written.push({
          kind: 'entity',
          id: 'Project',
          writtenAt: '2026-11-25T10:00:00.000Z',
          future: 42,
        });
      }),
    ]);
    const bytes = await readFile(file, 'utf8');
    await startup();
    await startup();
    expect(await readFile(file, 'utf8')).toBe(bytes);
    const restored = createConsolidatorState(dirname(file));
    await restored.start();
    expect(restored.get()).toEqual(state.get());
    expect(restored.get().future).toEqual({ keep: true });
    expect(restored.get().written[0]?.future).toBe(42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
