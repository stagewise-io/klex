import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { CONFIG_STORE_DEFINITION, createConfig } from '@/config';
import { createLocalData } from '@/local-data';

import { createProviderRegistry } from '../provider-registry';
import { langdockProviderDefinition } from './langdock';

it('keeps discovered routes through the real cache, partial failures, and settings changes', async () => {
  const logging = {
    child: () => ({ error() {}, info() {}, warn() {} }),
  } as unknown as RootLogger;
  const directory = await mkdtemp(join(tmpdir(), 'langdock-registry-'));
  await writeFile(
    join(directory, 'config.json'),
    await readFile(
      new URL(
        '../../local-data-migration-fixtures/config-v12-langdock-baseline.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const localData = createLocalData({
    logging,
    dataDirectory: directory,
    klexVersion: '0.37.1',
    stores: [CONFIG_STORE_DEFINITION],
  });
  const config = createConfig({
    logging,
    dataDirectory: directory,
    env: { PRIMARY_API_KEY: 'synthetic' },
  });
  const registry = createProviderRegistry({
    logging,
    config,
    definitions: [langdockProviderDefinition],
  });
  let phase = 'complete';
  const fetch = vi.fn(async (input) => {
    const url = String(input);
    if (
      phase === 'failed' ||
      (phase === 'partial-openai' && url.includes('/openai/')) ||
      (phase === 'partial' && !url.includes('/openai/'))
    )
      throw new Error('offline');
    if (url.includes('/google/'))
      return Response.json({ models: [{ name: 'models/custom-google' }] });
    return Response.json({
      data: [
        { id: 'shared' },
        ...(url.includes('/anthropic/') ? [{ id: 'custom-anthropic' }] : []),
      ],
    });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await localData.start();
    await config.start();
    await registry.start();
    expect(
      await registry.addInstance({
        id: 'gateway',
        type: 'langdock',
        settings: { apiKey: 'synthetic' },
      }),
    ).toMatchObject({ ok: true });
    expect(await registry.listModels('gateway')).toMatchObject({ ok: true });
    const count = fetch.mock.calls.length;
    await registry.listModels('gateway');
    expect(fetch).toHaveBeenCalledTimes(count);
    const model = (id: string) =>
      registry.getLanguageModel({ providerId: 'gateway', modelId: id });
    expect(model('custom-anthropic').provider).toBe('anthropic.messages');
    expect(model('custom-google').provider).toBe('google.generative-ai');
    expect(model('anthropic/shared').provider).toBe('anthropic.messages');
    expect(model('shared').provider).toBe('openai.chat');
    phase = 'partial';
    await registry.listModels('gateway', true);
    expect(model('custom-anthropic').provider).toBe('anthropic.messages');
    expect(model('custom-google').provider).toBe('google.generative-ai');
    phase = 'failed';
    await registry.listModels('gateway', true);
    expect(model('custom-google').provider).toBe('google.generative-ai');
    phase = 'partial-openai';
    await registry.listModels('gateway', true);
    expect(model('shared').provider).toBe('openai.chat');
    expect(model('anthropic/shared').provider).toBe('anthropic.messages');
    expect(
      await registry.addInstance({
        id: 'other',
        type: 'langdock',
        settings: { apiKey: 'other-key' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      registry.getLanguageModel({
        providerId: 'other',
        modelId: 'custom-google',
      }).provider,
    ).toBe('openai.chat');
    expect(
      await registry.updateInstance('gateway', {
        settings: { apiKey: 'changed', region: 'us' },
      }),
    ).toMatchObject({ ok: true });
    expect(model('custom-google').provider).toBe('openai.chat');
    expect(
      await readFile(join(directory, 'config.json'), 'utf8'),
    ).not.toContain('upstreamId');
  } finally {
    vi.unstubAllGlobals();
    await registry.close();
    await config.close();
    await localData.close();
    await rm(directory, { recursive: true, force: true });
  }
});
