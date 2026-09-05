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
  it('returns "Your name is X." for a simple name', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('Echo')));
    expect(ext.getSystemPromptPart!()).toBe('Your name is Echo.');
  });

  it('trims leading and trailing whitespace from the name', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('  Zephyr  ')));
    expect(ext.getSystemPromptPart!()).toBe('Your name is Zephyr.');
  });

  it('truncates names longer than 128 characters', () => {
    const longName = 'A'.repeat(200);
    const ext = createNameLoaderExt.create(makeDeps(makeConfig(longName)));
    const part = ext.getSystemPromptPart!();
    expect(part).toBe(`Your name is ${'A'.repeat(128)}.`);
  });

  it('truncates names by Unicode code point', () => {
    const ext = createNameLoaderExt.create(
      makeDeps(makeConfig('😀'.repeat(129))),
    );
    const part = ext.getSystemPromptPart!();

    expect(part).toBe(`Your name is ${'😀'.repeat(128)}.`);
  });

  it('passes through names at exactly 128 characters', () => {
    const name = 'B'.repeat(128);
    const ext = createNameLoaderExt.create(makeDeps(makeConfig(name)));
    expect(ext.getSystemPromptPart!()).toBe(`Your name is ${name}.`);
  });

  it('handles the default name "Agent"', () => {
    const ext = createNameLoaderExt.create(makeDeps(makeConfig('Agent')));
    expect(ext.getSystemPromptPart!()).toBe('Your name is Agent.');
  });

  it('handles names with internal whitespace', () => {
    const ext = createNameLoaderExt.create(
      makeDeps(makeConfig('  The Helper  ')),
    );
    expect(ext.getSystemPromptPart!()).toBe('Your name is The Helper.');
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
