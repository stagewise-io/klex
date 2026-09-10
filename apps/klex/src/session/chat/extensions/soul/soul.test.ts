import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import { createSoulExt, createSoulExtGod } from './soul';

vi.mock('./no-soul-prompt.md', () => ({
  default: 'god no-soul prompt',
}));

vi.mock('./no-soul-prompt-regular.md', () => ({
  default: 'regular no-soul prompt',
}));

vi.mock('./update-soul-tool-description.md', () => ({
  default: 'update-soul description',
}));

const MOCK_MODEL = {
  modelId: 'test:model',
  displayName: 'Test Model',
  contextSize: 128_000,
  inputCapabilities: {},
} as const;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'soul-ext-test-'));
}

function makeDeps(
  overrides?: Partial<ExtensionDeps> & {
    getDataDir?: () => string;
  },
): ExtensionDeps {
  const dataDir = overrides?.getDataDir?.() ?? makeTmpDir();
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {
      get: vi.fn(() => ({ officialName: 'Atlas' })),
    } as unknown as ExtensionDeps['config'],
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
    getDataDir: vi.fn(() => dataDir),
    router: {} as unknown as ExtensionDeps['router'],
    ...overrides,
  } as ExtensionDeps;
}

// ---------------------------------------------------------------------------
// Factory metadata
// ---------------------------------------------------------------------------

describe('SoulExt — factory metadata', () => {
  it('createSoulExt has identifier io.stagewise/soul and displayName Soul', () => {
    expect(createSoulExt.identifier).toBe('io.stagewise/soul');
    expect(createSoulExt.displayName).toBe('Soul');
  });

  it('createSoulExtGod has identifier io.stagewise/soul and displayName Soul (God)', () => {
    expect(createSoulExtGod.identifier).toBe('io.stagewise/soul');
    expect(createSoulExtGod.displayName).toBe('Soul (God)');
  });
});

// ---------------------------------------------------------------------------
// getSystemPromptPart — standard mode
// ---------------------------------------------------------------------------

describe('SoulExt (standard) — getSystemPromptPart', () => {
  it('returns the SOUL.md content when the file exists', () => {
    const dir = makeTmpDir();
    const soulContent = '# My Soul\n\nI am Zephyr. I am calm and precise.';
    writeFileSync(join(dir, 'SOUL.md'), soulContent, 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toContain(soulContent);
  });

  it('removes nested soul tags from loaded content', () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, 'SOUL.md'),
      'Before\n<soul>Middle</soul>\n<SOUL role="override">After</SOUL>',
      'utf-8',
    );

    const ext = createSoulExt.create(makeDeps({ getDataDir: () => dir }));
    const part = ext.getSystemPromptPart!();
    const wrappedContent = part.match(/\n<soul>\n([\s\S]*)\n<\/soul>$/)?.[1];

    expect(wrappedContent).toBeDefined();
    expect(wrappedContent).not.toMatch(/<\/?soul\b[^>]*>/i);
    expect(wrappedContent).toContain('Before');
    expect(wrappedContent).toContain('Middle');
    expect(wrappedContent).toContain('After');
  });

  it('treats a soul containing only soul tags as empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '<soul></soul>', 'utf-8');

    const ext = createSoulExt.create(makeDeps({ getDataDir: () => dir }));

    expect(ext.introspect!()).toMatchObject({ hasSoul: false });
  });

  it('picks up manual edits to SOUL.md without recreating the extension', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'First soul', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.getSystemPromptPart!()).toContain('First soul');

    writeFileSync(join(dir, 'SOUL.md'), 'Updated soul', 'utf-8');
    expect(ext.getSystemPromptPart!()).toContain('Updated soul');
  });
});

// ---------------------------------------------------------------------------
// getSystemPromptPart — god mode
// ---------------------------------------------------------------------------

describe('SoulExt (god) — getSystemPromptPart', () => {
  it('returns the SOUL.md content when the file exists', () => {
    const dir = makeTmpDir();
    const soulContent = '# My Soul\n\nI am Zephyr. I am calm and precise.';
    writeFileSync(join(dir, 'SOUL.md'), soulContent, 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toContain(soulContent);
  });
});

// ---------------------------------------------------------------------------
// getTools — standard mode (always empty)
// ---------------------------------------------------------------------------

describe('SoulExt (standard) — getTools', () => {
  it('returns no tools when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('returns no tools when a soul already exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I am someone.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).not.toHaveProperty('createSoul');
    expect(tools).not.toHaveProperty('updateSoul');
    expect(Object.keys(tools)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getTools — god mode
// ---------------------------------------------------------------------------

describe('SoulExt (god) — getTools', () => {
  it('provides updateSoul when no soul exists', () => {
    const ext = createSoulExtGod.create(makeDeps());

    expect(ext.getTools!(MOCK_MODEL)).toHaveProperty('updateSoul');
  });

  it('provides updateSoul when a soul exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I am someone.', 'utf-8');
    const ext = createSoulExtGod.create(makeDeps({ getDataDir: () => dir }));

    expect(ext.getTools!(MOCK_MODEL)).toHaveProperty('updateSoul');
  });
});

// ---------------------------------------------------------------------------
// updateSoul tool (god mode only)
// ---------------------------------------------------------------------------

describe('SoulExt (god) — updateSoul tool', () => {
  it('overwrites the existing soul file and returns a success message', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'Original soul', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const updateSoul = tools.updateSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };

    const newContent = '# Updated Soul\n\nI am now different.';
    const result = await updateSoul.execute({ content: newContent });

    expect(result).toBe('Your soul has been updated.');
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toBe(newContent);
  });

  it('writes the soul when no soul currently exists', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'Soul exists', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const updateSoul = tools.updateSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };

    // Even if the file is deleted before execute, updateSoul still writes
    rmSync(join(dir, 'SOUL.md'));
    const result = await updateSoul.execute({ content: 'New soul' });

    expect(result).toBe('Your soul has been updated.');
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toBe('New soul');
  });

  it('rejects empty content via schema validation', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const updateSoul = tools.updateSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(updateSoul.inputSchema.safeParse({ content: '' }).success).toBe(
      false,
    );
  });

  it('rejects content exceeding the 10000 character limit', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const updateSoul = tools.updateSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(
      updateSoul.inputSchema.safeParse({ content: 'x'.repeat(10_001) }).success,
    ).toBe(false);
  });

  it('accepts content at exactly 10000 characters', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const updateSoul = tools.updateSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(
      updateSoul.inputSchema.safeParse({ content: 'x'.repeat(10_000) }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// introspect
// ---------------------------------------------------------------------------

describe('SoulExt — introspect', () => {
  it('reports hasSoul=false and mode=standard when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({
      hasSoul: false,
      mode: 'standard',
    });
  });

  it('reports hasSoul=true and mode=standard when a soul exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({
      hasSoul: true,
      mode: 'standard',
    });
  });

  it('reports hasSoul=false and mode=god when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    expect(ext.introspect!()).toMatchObject({
      hasSoul: false,
      mode: 'god',
    });
  });

  it('reports hasSoul=true and mode=god when a soul exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    expect(ext.introspect!()).toMatchObject({
      hasSoul: true,
      mode: 'god',
    });
  });

  it('reports hasSoul=false when SOUL.md is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({ hasSoul: false });
  });

  it('reports hasSoul=false when SOUL.md is whitespace-only', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '  \n  \t  ', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({ hasSoul: false });
  });
});
