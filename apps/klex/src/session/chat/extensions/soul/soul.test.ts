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
  default: '# Your soul\n\nYou have no soul right now.',
}));

vi.mock('./no-soul-prompt-regular.md', () => ({
  default: "# Where am I?\n\nYou don't know who you are.",
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
  it('returns the regular no-soul prompt when no SOUL.md exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe("# Where am I?\n\nYou don't know who you are.");
  });

  it('returns the SOUL.md content when the file exists', () => {
    const dir = makeTmpDir();
    const soulContent = '# My Soul\n\nI am Zephyr. I am calm and precise.';
    writeFileSync(join(dir, 'SOUL.md'), soulContent, 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe(soulContent);
  });

  it('returns the regular no-soul prompt when SOUL.md exists but is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe("# Where am I?\n\nYou don't know who you are.");
  });

  it('picks up manual edits to SOUL.md without recreating the extension', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'First soul', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.getSystemPromptPart!()).toBe('First soul');

    writeFileSync(join(dir, 'SOUL.md'), 'Updated soul', 'utf-8');
    expect(ext.getSystemPromptPart!()).toBe('Updated soul');
  });
});

// ---------------------------------------------------------------------------
// getSystemPromptPart — god mode
// ---------------------------------------------------------------------------

describe('SoulExt (god) — getSystemPromptPart', () => {
  it('returns the aggressive no-soul prompt when no SOUL.md exists', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe('# Your soul\n\nYou have no soul right now.');
  });

  it('returns the SOUL.md content when the file exists', () => {
    const dir = makeTmpDir();
    const soulContent = '# My Soul\n\nI am Zephyr. I am calm and precise.';
    writeFileSync(join(dir, 'SOUL.md'), soulContent, 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe(soulContent);
  });

  it('returns the aggressive no-soul prompt when SOUL.md exists but is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe('# Your soul\n\nYou have no soul right now.');
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
  it('provides the createSoul tool when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
    expect(tools).not.toHaveProperty('updateSoul');
  });

  it('provides updateSoul (not createSoul) when a soul exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I am someone.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('updateSoul');
    expect(tools).not.toHaveProperty('createSoul');
  });

  it('provides createSoul when SOUL.md exists but is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
  });

  it('provides createSoul when SOUL.md is whitespace-only', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '   \n\t  \n', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
  });
});

// ---------------------------------------------------------------------------
// createSoul tool (god mode only)
// ---------------------------------------------------------------------------

describe('SoulExt (god) — createSoul tool', () => {
  it('writes the soul file and returns a success message', async () => {
    const dir = makeTmpDir();
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };

    const soulContent = '# My Soul\n\nI am Echo. Brief and sharp.';
    const result = await createSoul.execute({ content: soulContent });

    expect(result).toContain('saved');
    expect(existsSync(join(dir, 'SOUL.md'))).toBe(true);
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toBe(soulContent);
  });

  it('creates the extension directory if it does not exist', async () => {
    const baseDir = makeTmpDir();
    const extDir = join(baseDir, 'nested', 'soul-dir');

    const deps = makeDeps({ getDataDir: () => extDir });
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };

    expect(existsSync(extDir)).toBe(false);

    await createSoul.execute({ content: 'I am Forge.' });

    expect(existsSync(join(extDir, 'SOUL.md'))).toBe(true);
  });

  it('rejects empty content via schema validation', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(createSoul.inputSchema.safeParse({ content: '' }).success).toBe(
      false,
    );
  });

  it('rejects whitespace-only content via schema validation', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(
      createSoul.inputSchema.safeParse({ content: '  \n\t ' }).success,
    ).toBe(false);
  });

  it('rejects content exceeding the 10000 character limit', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(
      createSoul.inputSchema.safeParse({ content: 'x'.repeat(10_001) }).success,
    ).toBe(false);
  });

  it('accepts content at exactly 10000 characters', () => {
    const deps = makeDeps();
    const ext = createSoulExtGod.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(
      createSoul.inputSchema.safeParse({ content: 'x'.repeat(10_000) }).success,
    ).toBe(true);
  });

  it('refuses to overwrite an existing soul', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'Original soul', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    // Simulate the edge case where the tool was registered (soul didn't
    // exist at getTools time) but the file appeared before execute ran.
    rmSync(join(dir, 'SOUL.md'));
    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };
    writeFileSync(join(dir, 'SOUL.md'), 'Soul appeared', 'utf-8');

    const result = await createSoul.execute({ content: 'New soul' });

    expect(result).toContain('already exists');
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toBe('Soul appeared');
  });

  it('tool disappears after soul is created (next step)', async () => {
    const dir = makeTmpDir();
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExtGod.create(deps);

    // Step 1: no soul → createSoul available
    const toolsBefore = ext.getTools!(MOCK_MODEL);
    expect(toolsBefore).toHaveProperty('createSoul');

    const createSoul = toolsBefore.createSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };
    await createSoul.execute({ content: 'I am now alive.' });

    // Step 2: soul exists → updateSoul available (not createSoul)
    const toolsAfter = ext.getTools!(MOCK_MODEL);
    expect(toolsAfter).not.toHaveProperty('createSoul');
    expect(toolsAfter).toHaveProperty('updateSoul');
  });
});

// ---------------------------------------------------------------------------
// updateSoul tool (god mode only, when soul exists)
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

  it('always overwrites — no race guard (unlike createSoul)', async () => {
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
