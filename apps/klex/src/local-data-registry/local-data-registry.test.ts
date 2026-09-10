import { describe, expect, it } from 'vitest';

import { validateLocalDataRegistry } from '@/local-data';

import { KLEX_LOCAL_DATA_STORES } from './local-data-registry';

describe('Klex local-data registry', () => {
  it('contains the complete structured store inventory', () => {
    expect(KLEX_LOCAL_DATA_STORES.map((store) => store.id)).toEqual([
      'config',
      'model-calls',
      'mcp-oauth',
      'cloud-identity-metadata',
      'cloud-enrollment',
      'time-extension-timezone',
    ]);
  });

  it('returns a valid registry with unique IDs and paths', () => {
    const registry = KLEX_LOCAL_DATA_STORES;
    expect(() => validateLocalDataRegistry(registry)).not.toThrow();
    expect(new Set(registry.map((store) => store.id)).size).toBe(
      registry.length,
    );
    expect(new Set(registry.map((store) => store.relativePath)).size).toBe(
      registry.length,
    );
  });

  it('declares a current schema and contiguous migrations for every store', () => {
    for (const store of KLEX_LOCAL_DATA_STORES) {
      if (store.kind === 'json') {
        expect(
          store.versions.some(({ version }) => version === store.schemaVersion),
        ).toBe(true);
      }
      for (let index = 1; index < store.migrations.length; index += 1) {
        expect(store.migrations[index]?.from).toBe(
          store.migrations[index - 1]?.to,
        );
      }
    }
  });
});
