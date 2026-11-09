import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type z from 'zod';

import type { ExtendedUIMessage } from '../../message-types';
import type { ExtensionDeps } from '../extension-api';
import { createSoulExt, createSoulExtGod, readSoul } from './soul';

vi.mock('./system-prompt-part/no-soul-god.md', () => ({
  default: 'god no-soul prompt',
}));

vi.mock('./generation-prompt.md', () => ({
  default: 'Soul generation instructions',
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
    checkpoints: {
      commit: vi.fn(() => ({ status: 'pending' as const })),
      isPending: vi.fn(() => false),
    },
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
    sessionContext: {
      kind: 'default',
      sessionId: 'test-session-id',
    } as unknown as ExtensionDeps['sessionContext'],
    createChildSession:
      vi.fn() as unknown as ExtensionDeps['createChildSession'],
    ...overrides,
  } as ExtensionDeps;
}

// ---------------------------------------------------------------------------
// Factory metadata
// ---------------------------------------------------------------------------

describe('readSoul', () => {
  it('reads sanitized content on every call and distinguishes missing or empty souls', () => {
    const dir = makeTmpDir();
    try {
      expect(readSoul(dir)).toBeNull();
      writeFileSync(join(dir, 'SOUL.md'), '<soul>First</soul>');
      expect(readSoul(dir)).toBe('First');
      writeFileSync(join(dir, 'SOUL.md'), 'Updated');
      expect(readSoul(dir)).toBe('Updated');
      writeFileSync(join(dir, 'SOUL.md'), ' \n<soul></soul>\t ');
      expect(readSoul(dir)).toBeNull();
      rmSync(join(dir, 'SOUL.md'));
      expect(readSoul(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates read failures instead of treating unreadable content as a missing soul', () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, 'SOUL.md'));
      expect(() => readSoul(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    expect(part).not.toContain('<soul-writing-guidelines>');
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

  it('contributes no prompt when no soul exists', () => {
    const ext = createSoulExt.create(makeDeps());

    expect(ext.getSystemPromptPart!()).toBe('');
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
    expect(part).toContain('<soul-writing-guidelines>');
    expect(part).toContain('updateSoul');
  });

  it('returns the god no-soul prompt when no soul exists', () => {
    const ext = createSoulExtGod.create(makeDeps());

    expect(ext.getSystemPromptPart!()).toContain('god no-soul prompt');
    expect(ext.getSystemPromptPart!()).toContain('<soul-writing-guidelines>');
  });
});

// ---------------------------------------------------------------------------
// No-soul prompt files — guard against swapped contents
// ---------------------------------------------------------------------------

describe('no-soul prompt files', () => {
  const readPrompt = (file: string) =>
    readFileSync(
      new URL(`./system-prompt-part/${file}`, import.meta.url),
      'utf-8',
    );

  it('god prompt retains explicit legacy soul setup for the deployed cloud', () => {
    const prompt = readPrompt('no-soul-god.md');
    expect(prompt).toContain('explicit god message');
    expect(prompt).toContain('updateSoul');
    expect(prompt).not.toContain('cannot create or change your soul');
  });
});

// ---------------------------------------------------------------------------
// getTools — standard mode (always empty)
// ---------------------------------------------------------------------------

describe('SoulExt — step decision', () => {
  it('drops only newly added history without a soul, including after deletion', async () => {
    const dir = makeTmpDir();
    const restored: ExtendedUIMessage = {
      id: 'restored',
      role: 'assistant',
      parts: [],
    };
    const history = [restored];
    const deps = makeDeps({
      getDataDir: () => dir,
      getHistory: () => [...history],
    });
    const ext = createSoulExt.create(deps);
    try {
      await ext.onStart!();
      for (const content of ['', '  ', '<soul></soul>']) {
        writeFileSync(join(dir, 'SOUL.md'), content);
        history.push({ id: 'discarded', role: 'user', parts: [] });
        expect(ext.shouldRunStep!(history)).toBe(false);
        expect(history).toEqual([restored]);
      }
      writeFileSync(join(dir, 'SOUL.md'), 'I help with precision.');
      history.push({ id: 'accepted', role: 'user', parts: [] });
      expect(ext.shouldRunStep!(history)).toBe(true);
      await ext.onStepComplete!({} as never);
      rmSync(join(dir, 'SOUL.md'));
      // Also drop mid-history inserts, not just the trailing message.
      history.splice(1, 0, { id: 'discarded-insert', role: 'user', parts: [] });
      history.push({ id: 'discarded-after-deletion', role: 'user', parts: [] });
      expect(ext.shouldRunStep!(history)).toBe(false);
      expect(history.map((message) => message.id)).toEqual([
        'restored',
        'accepted',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows god steps without a soul and leaves their history intact', () => {
    const dir = makeTmpDir();
    try {
      const history: ExtendedUIMessage[] = [
        { id: 'directive', role: 'user', parts: [] },
      ];
      const ext = createSoulExtGod.create(makeDeps({ getDataDir: () => dir }));
      expect(ext.shouldRunStep!(history)).toBe(true);
      expect(history).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe('SoulExt (god) — legacy updateSoul compatibility', () => {
  it('rejects a tag-only tool write without replacing a working soul', async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'SOUL.md'), 'Existing identity');
      const ext = createSoulExtGod.create(makeDeps({ getDataDir: () => dir }));
      const update = ext.getTools!(MOCK_MODEL).updateSoul as Tool<
        { content: string },
        string
      >;
      await expect(
        update.execute!(
          { content: '<soul> </soul>' },
          { toolCallId: 'empty', messages: [], context: undefined },
        ),
      ).rejects.toThrow('must not be blank');
      expect(readSoul(dir)).toBe('Existing identity');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the same content schema and success result before and after creation', async () => {
    const dir = makeTmpDir();
    try {
      const ext = createSoulExtGod.create(makeDeps({ getDataDir: () => dir }));
      for (const content of ['New soul', 'Updated soul']) {
        const tools = ext.getTools?.(MOCK_MODEL);
        expect(Object.keys(tools ?? {})).toEqual(['updateSoul']);
        const update = tools?.updateSoul as
          | Tool<{ content: string }, string>
          | undefined;
        const schema = update?.inputSchema as z.ZodType;
        for (const content of [
          '',
          ' \n ',
          '<soul> </soul>',
          'x'.repeat(10_001),
        ]) {
          expect(schema.safeParse({ content }).success).toBe(false);
        }
        expect(schema.safeParse({ content: 'x'.repeat(10_000) }).success).toBe(
          true,
        );
        expect(update?.description).toContain('god message explicitly orders');
        const execute = update?.execute;
        if (!execute) throw new Error('Missing legacy execute');
        const result = await execute(
          { content },
          { toolCallId: 'legacy', messages: [], context: undefined },
        );
        expect(result).toBe('Your soul has been updated.');
        expect(readFileSync(join(dir, 'SOUL.md'), 'utf8')).toBe(content);
        expect(ext.getSystemPromptPart?.()).toContain(content);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
