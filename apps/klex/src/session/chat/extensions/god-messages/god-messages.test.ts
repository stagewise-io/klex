import { describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import {
  createGodMessagesDistrustExt,
  createGodMessagesTrustExt,
} from './god-messages';

vi.mock('./trust-prompt.md', () => ({ default: 'TRUST_PROMPT' }));
vi.mock('./distrust-prompt.md', () => ({ default: 'DISTRUST_PROMPT' }));

function makeDeps(): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: { send: vi.fn(), sendMessage: vi.fn(), close: vi.fn() },
    config: {} as unknown as ExtensionDeps['config'],
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
    sessionId: 'test-session-id',
    getDataDir: vi.fn(() => '/tmp/test'),
  } as unknown as ExtensionDeps;
}

describe('GodMessagesExt — trust mode', () => {
  it('returns the trust prompt', () => {
    const ext = createGodMessagesTrustExt.create(makeDeps());
    expect(ext.getSystemPromptPart!()).toBe('TRUST_PROMPT');
  });

  it('introspects with mode: trust', () => {
    const ext = createGodMessagesTrustExt.create(makeDeps());
    expect(ext.introspect!()).toEqual({ mode: 'trust' });
  });
});

describe('GodMessagesExt — distrust mode', () => {
  it('returns the distrust prompt', () => {
    const ext = createGodMessagesDistrustExt.create(makeDeps());
    expect(ext.getSystemPromptPart!()).toBe('DISTRUST_PROMPT');
  });

  it('introspects with mode: distrust', () => {
    const ext = createGodMessagesDistrustExt.create(makeDeps());
    expect(ext.introspect!()).toEqual({ mode: 'distrust' });
  });
});

describe('GodMessagesExt — factory identifiers', () => {
  it('trust factory has correct identifier and displayName', () => {
    expect(createGodMessagesTrustExt.identifier).toBe(
      'io.stagewise/god-messages-trust',
    );
    expect(createGodMessagesTrustExt.displayName).toBe('God Messages (Trust)');
  });

  it('distrust factory has correct identifier and displayName', () => {
    expect(createGodMessagesDistrustExt.identifier).toBe(
      'io.stagewise/god-messages-distrust',
    );
    expect(createGodMessagesDistrustExt.displayName).toBe(
      'God Messages (Distrust)',
    );
  });
});
