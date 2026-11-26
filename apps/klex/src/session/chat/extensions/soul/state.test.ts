import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_LOCAL_DATA_STORES } from '@/local-data-registry';
import { KLEX_VERSION } from '@/release';

import { soulFailureMessages } from './failure';
import { readSoulState, writeSoulFailure } from './state';

it('passes registered startup, preserves unknown fields, and rejects newer state without mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soul-state-'));
  const definition = KLEX_LOCAL_DATA_STORES.find(
    (store) => store.id === 'soul-extension-state',
  )!;
  const path = join(directory, definition.relativePath);
  const start = () =>
    createLocalData({
      dataDirectory: directory,
      stores: [definition],
      klexVersion: KLEX_VERSION,
      logging: createLogger({ name: 'test' }),
    }).start();
  try {
    await start();
    expect(await readSoulState(dirname(path))).toBeUndefined();
    const failure = {
      kind: 'soul_generation_failed',
      category: 'auth',
      reason: 'provider_error',
      providerId: 'provider',
      providerType: 'openai',
      modelId: 'model',
      statusCode: 401,
      message: soulFailureMessages.auth,
    } as const;
    await writeSoulFailure(dirname(path), failure);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.future = { keep: true };
    raw.failure.future = true;
    await writeFile(path, JSON.stringify(raw));
    const before = await readFile(path, 'utf8');
    await start();
    await start();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await readSoulState(dirname(path)))?.payload.failure).toMatchObject(
      { ...failure, future: true },
    );
    await writeSoulFailure(dirname(path), null);
    expect((await readSoulState(dirname(path)))?.payload).toEqual({
      failure: null,
      future: { keep: true },
    });
    raw._klex.schemaVersion = 2;
    await writeFile(path, JSON.stringify(raw));
    await expect(start()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(raw));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
