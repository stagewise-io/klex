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
import { createSoulExt } from './soul';

vi.mock('./no-soul-prompt.md', () => ({
  default: '# Your soul\n\nYou have no soul right now.',
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
    ...overrides,
  } as ExtensionDeps;
}

describe('SoulExt — getSystemPromptPart', () => {
  it('returns the no-soul prompt when no SOUL.md exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe('# Your soul\n\nYou have no soul right now.');
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

  it('returns the no-soul prompt when SOUL.md exists but is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const part = ext.getSystemPromptPart!();

    expect(part).toBe('# Your soul\n\nYou have no soul right now.');
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

describe('SoulExt — getTools', () => {
  it('provides the createSoul tool when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
  });

  it('does not provide createSoul when a soul already exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I am someone.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).not.toHaveProperty('createSoul');
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('provides createSoul when SOUL.md exists but is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
  });

  it('provides createSoul when SOUL.md is whitespace-only', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), '   \n\t  \n', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);

    expect(tools).toHaveProperty('createSoul');
  });
});

describe('SoulExt — createSoul tool', () => {
  it('writes the soul file and returns a success message', async () => {
    const dir = makeTmpDir();
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

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
    const ext = createSoulExt.create(deps);

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
    const ext = createSoulExt.create(deps);

    const tools = ext.getTools!(MOCK_MODEL);
    const createSoul = tools.createSoul as unknown as {
      inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    };

    expect(createSoul.inputSchema.safeParse({ content: '' }).success).toBe(
      false,
    );
  });

  it('rejects content exceeding the 10000 character limit', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

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
    const ext = createSoulExt.create(deps);

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
    const ext = createSoulExt.create(deps);

    // Simulate the edge case where the tool was registered (soul didn't
    // exist at getTools time) but the file appeared before execute ran.
    // We call execute directly on a tool object obtained when no soul
    // existed. To simulate the race, we delete the file, get the tool,
    // then recreate the file before calling execute.
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
    const ext = createSoulExt.create(deps);

    // Step 1: no soul → tool available
    const toolsBefore = ext.getTools!(MOCK_MODEL);
    expect(toolsBefore).toHaveProperty('createSoul');

    const createSoul = toolsBefore.createSoul as unknown as {
      execute: (args: { content: string }) => Promise<string>;
    };
    await createSoul.execute({ content: 'I am now alive.' });

    // Step 2: soul exists → tool gone
    const toolsAfter = ext.getTools!(MOCK_MODEL);
    expect(toolsAfter).not.toHaveProperty('createSoul');
  });
});

describe('SoulExt — introspect', () => {
  it('reports hasSoul=false when no soul exists', () => {
    const deps = makeDeps();
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({ hasSoul: false });
  });

  it('reports hasSoul=true when a soul exists', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'SOUL.md'), 'I exist.', 'utf-8');

    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createSoulExt.create(deps);

    expect(ext.introspect!()).toMatchObject({ hasSoul: true });
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
