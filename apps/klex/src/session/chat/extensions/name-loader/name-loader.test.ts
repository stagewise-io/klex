import { describe, expect, it, vi } from 'vitest';

import type { Config } from '@/config';

import type { ExtensionDeps } from '../extension-api';
import { createNameLoaderExt } from './name-loader';

function makeConfig(officialName: string): Config {
  return {
    get: () => ({ officialName }) as unknown as ReturnType<Config['get']>,
  } as unknown as Config;
}

function makeDeps(config: Config): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: { send: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
    config,
    modelResolver: {} as ExtensionDeps['modelResolver'],
    generateText: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    logging: {
      child: () => ({ info: vi.fn() }) as unknown as ExtensionDeps['logger'],
    } as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    router: {} as unknown as ExtensionDeps['router'],
    sessionId: 'test-session-id',
    getDataDir: vi.fn(() => '/tmp/test'),
  } as ExtensionDeps;
}

describe('NameLoaderExt — getSystemPromptPart', () => {
  it('includes the resolved name', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('Echo')));
    expect(ext.getSystemPromptPart!()).toContain('Echo');
  });
});

describe('NameLoaderExt — introspect', () => {
  it('reports the resolved name', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('Echo')));
    expect(ext.introspect!()).toEqual({ name: 'Echo' });
  });

  it('reports the trimmed name in introspection', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('  Zephyr  ')));
    expect(ext.introspect!()).toEqual({ name: 'Zephyr' });
  });

  it('reports the truncated name in introspection', () => {
    const longName = 'C'.repeat(200);
    const ext = createNameLoaderExt.create(makeDeps(makeConfig(longName)));
    expect(ext.introspect!()).toEqual({ name: 'C'.repeat(128) });
  });
});

describe('NameLoaderExt — factory', () => {
  it('has correct identifier and displayName', () => {
    expect(createNameLoaderExt.identifier).toBe('io.stagewise/name-loader');
    expect(createNameLoaderExt.displayName).toBe('Name Loader');
  });
});
