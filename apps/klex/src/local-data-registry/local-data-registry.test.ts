import { describe, expect, it, vi } from 'vitest';

// Store definitions come from extension barrels; stub their prompt imports.
vi.mock('@/session/chat/extensions/todos/system-prompt.md', () => ({
  default: '',
}));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));
vi.mock('@/session/chat/extensions/memory/system-prompt-part.md', () => ({
  default: '',
}));
vi.mock(
  '@/session/chat/extensions/memory/retrieval/retrieval-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/memory/episodic-writer/writer-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/soul/system-prompt-part/no-soul-god.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/soul/system-prompt-part/no-soul-regular.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/soul/update-soul-tool-description.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/audio-input-optimizer/audio-system-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/audio-input-optimizer/audio-tool-system-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/image-input-optimizer/vision-system-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/image-input-optimizer/vision-tool-system-prompt.md',
  () => ({ default: '' }),
);
vi.mock(
  '@/session/chat/extensions/context-compaction/compaction-prompt.md',
  () => ({ default: '' }),
);

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
      'todos-extension-todos',
      'episodic-search-index',
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
