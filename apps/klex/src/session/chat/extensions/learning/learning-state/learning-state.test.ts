import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
  it('defaults when the file is missing', async () => {
    const state = createLearningState(await dataDir());
    await state.start();
    expect(state.get()).toEqual({
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
