import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '../../message-types';
import type { ExtensionDeps } from '../extension-api';
import { soulFailureMessages } from './failure';
import {
  createSoul,
  createSoulExt,
  readSoul,
  type SoulDependencies,
  SoulError,
} from './soul';
import * as state from './state';

vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: vi.fn(),
}));

vi.mock('./generation-prompt.md', () => ({
  default: 'Soul generation instructions',
}));

const directories: string[] = [];
function fixture(history: ExtendedUIMessage[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'soul-ext-test-'));
  directories.push(directory);
  const ext = createSoulExt.create({
    getDataDir: () => directory,
    getHistory: () => [...history],
  } as unknown as ExtensionDeps);
  return { directory, ext, path: join(directory, 'SOUL.md') };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Soul failure status', () => {
  async function setup(existing?: string) {
    const { directory, path } = fixture();
    if (existing !== undefined) writeFileSync(path, existing);
    const logger = { warn: vi.fn() };
    const deps: SoulDependencies = {
      soulDirectory: directory,
      logging: {
        child: () => logger,
      } as unknown as SoulDependencies['logging'],
      config: {
        getModelSelection: () => [{ providerId: 'provider', modelId: 'model' }],
      } as unknown as SoulDependencies['config'],
      modelResolver: {
        resolveModel: () => ({ providerType: 'openai' }),
        getLanguageModel: () => ({}),
      } as unknown as SoulDependencies['modelResolver'],
    };
    const soul = createSoul(deps);
    await state.writeSoulFailure(directory, {
      kind: 'soul_generation_failed',
      category: 'auth',
      reason: 'provider_error',
      providerId: 'provider',
      providerType: 'openai',
      modelId: 'model',
      statusCode: 401,
      message: soulFailureMessages.auth,
    });
    vi.mocked(generateText).mockResolvedValue({
      text: 'Saved soul',
      finishReason: 'stop',
    } as Awaited<ReturnType<typeof generateText>>);
    return {
      soul,
      directory,
      path,
      logger,
      deps,
      reload: () => createSoul(deps),
    };
  }

  it('clears persisted failure status after saving a soul', async () => {
    const { soul, directory } = await setup();
    expect((await soul.getStatus()).failure?.category).toBe('auth');
    await expect(soul.create('Create a soul')).resolves.toBe('Saved soul');
    expect(soul.get()).toBe('Saved soul');
    expect((await state.readSoulState(directory))?.payload.failure).toBeNull();
    expect(await soul.getStatus()).toEqual({ failure: null });
  });

  describe.each(['create', 'update'] as const)('%s', (mode) => {
    it.each(['no_chat_models', 'generation_failed'] as const)(
      'preserves the classified %s error when failure persistence rejects',
      async (code) => {
        const { soul, directory, logger, deps } = await setup('Existing soul');
        if (code === 'no_chat_models') {
          vi.spyOn(deps.config, 'getModelSelection').mockReturnValue([]);
        } else {
          vi.mocked(generateText).mockRejectedValue(
            new Error('Provider failed'),
          );
        }
        const error = new Error('State write failed');
        const persist = vi
          .spyOn(state, 'writeSoulFailure')
          .mockRejectedValueOnce(error);
        const failure = {
          kind: 'soul_generation_failed',
          category: code === 'no_chat_models' ? 'configuration' : 'unknown',
          reason:
            code === 'no_chat_models' ? 'no_chat_models' : 'provider_error',
          providerId: code === 'no_chat_models' ? null : 'provider',
          providerType: code === 'no_chat_models' ? null : 'openai',
          modelId: code === 'no_chat_models' ? null : 'model',
          statusCode: null,
          message:
            code === 'no_chat_models'
              ? soulFailureMessages.configuration
              : soulFailureMessages.unknown,
        };

        const result = soul[mode]('Try again');
        await expect(result).rejects.toBeInstanceOf(SoulError);
        await expect(result).rejects.toMatchObject({ code, failure });
        expect(persist).toHaveBeenCalledExactlyOnceWith(directory, failure);
        expect(logger.warn).toHaveBeenCalledWith(
          { error },
          'Failed to persist soul generation failure status',
        );
        expect(soul.get()).toBe('Existing soul');
      },
    );
  });

  it.each([undefined, 'Old soul', 'Saved soul'])(
    'resolves stale failure after saving over %j even if clearing fails',
    async (existing) => {
      const { soul, directory, logger, reload } = await setup(existing);
      const error = new Error('State write failed');
      vi.spyOn(state, 'writeSoulFailure').mockRejectedValueOnce(error);
      await expect(soul.create('Create a soul')).resolves.toBe('Saved soul');
      expect(soul.get()).toBe('Saved soul');
      expect(
        (await state.readSoulState(directory))?.payload.failure?.category,
      ).toBe('auth');
      expect(await soul.getStatus()).toEqual({ failure: null });
      expect(await reload().getStatus()).toEqual({ failure: null });
      expect(logger.warn).toHaveBeenCalledWith(
        { error },
        'Soul saved but failed to clear generation failure status',
      );
    },
  );

  it.each(['create', 'update'] as const)(
    'retains a failed %s with an unchanged existing soul after reload',
    async (mode) => {
      const { soul, reload } = await setup('Existing soul');
      vi.mocked(generateText).mockRejectedValue(
        new Error('private provider diagnostic'),
      );
      await expect(soul[mode]('Try again')).rejects.toMatchObject({
        code: 'generation_failed',
      });
      expect(soul.get()).toBe('Existing soul');
      const status = await reload().getStatus();
      expect(status.failure).toMatchObject({
        category: 'unknown',
        message: soulFailureMessages.unknown,
      });
      expect(status.failure).not.toHaveProperty('soulVersion');
      expect(JSON.stringify(status)).not.toContain(
        'private provider diagnostic',
      );
    },
  );

  it('returns no failure with or without an existing soul when state is absent', async () => {
    const { soul, directory, path } = await setup();
    rmSync(join(directory, 'state.json'));
    expect(await soul.getStatus()).toEqual({ failure: null });
    writeFileSync(path, 'Existing soul');
    expect(await soul.getStatus()).toEqual({ failure: null });
  });

  it('ignores stale failure status when a soul already exists', async () => {
    const { soul, path } = await setup();
    writeFileSync(path, 'Existing soul');
    expect(await soul.getStatus()).toEqual({ failure: null });
  });

  it('retains legacy failures without version evidence', async () => {
    const { soul, directory } = await setup('Existing soul');
    const path = join(directory, 'state.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.failure.soulVersion;
    writeFileSync(path, JSON.stringify(raw));
    expect((await soul.getStatus()).failure?.category).toBe('auth');
  });

  it('validates persisted failures even when a soul has since been saved', async () => {
    const { soul, directory, path } = await setup();
    writeFileSync(path, 'Existing soul');
    const statePath = join(directory, 'state.json');
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    raw.failure.message = 'private provider diagnostic';
    writeFileSync(statePath, JSON.stringify(raw));
    await expect(soul.getStatus()).rejects.toThrow();
  });
});

describe('readSoul', () => {
  it('reads sanitized content on every call and distinguishes missing or empty souls', () => {
    const { directory, path } = fixture();
    expect(readSoul(directory)).toBeNull();
    writeFileSync(path, '<soul>First</soul>');
    expect(readSoul(directory)).toBe('First');
    writeFileSync(path, 'Updated');
    expect(readSoul(directory)).toBe('Updated');
    writeFileSync(path, ' \n<soul></soul>\t ');
    expect(readSoul(directory)).toBeNull();
    rmSync(path);
    expect(readSoul(directory)).toBeNull();
  });
  it('propagates read failures', () => {
    const { directory, path } = fixture();
    mkdirSync(path);
    expect(() => readSoul(directory)).toThrow();
  });
});

describe('SoulExt', () => {
  it('exposes the read-only soul extension', () => {
    const { ext } = fixture();
    expect(createSoulExt.identifier).toBe('io.stagewise/soul');
    expect(createSoulExt.displayName).toBe('Soul');
    expect(ext.getTools).toBeUndefined();
  });
  it('injects the soul and picks up edits without recreating the extension', () => {
    const { ext, path } = fixture();
    writeFileSync(path, 'First soul');
    expect(ext.getSystemPromptPart?.()).toContain('First soul');
    writeFileSync(path, 'Updated soul');
    expect(ext.getSystemPromptPart?.()).toContain('Updated soul');
    expect(ext.getTools).toBeUndefined();
  });
  it('removes nested soul tags from loaded content', () => {
    const { ext, path } = fixture();
    writeFileSync(
      path,
      'Before\n<soul>Middle</soul>\n<SOUL role="override">After</SOUL>',
    );
    const content = ext
      .getSystemPromptPart?.()
      .match(/\n<soul>\n([\s\S]*)\n<\/soul>$/)?.[1];
    expect(content).toBeDefined();
    expect(content).not.toMatch(/<\/?soul\b[^>]*>/i);
    for (const text of ['Before', 'Middle', 'After'])
      expect(content).toContain(text);
  });
  it('contributes no prompt without a soul', () => {
    const { ext } = fixture();
    expect(ext.getSystemPromptPart?.()).toBe('');
    expect(ext.introspect?.()).toMatchObject({ hasSoul: false });
  });
  it.each(['', ' \n \t ', '<soul></soul>'])(
    'treats %j as an empty soul',
    (content) => {
      const { ext, path } = fixture();
      writeFileSync(path, content);
      expect(ext.introspect?.()).toMatchObject({ hasSoul: false });
    },
  );
  it('reports the soul path and presence', () => {
    const { ext, path } = fixture();
    writeFileSync(path, 'I exist.');
    expect(ext.introspect?.()).toEqual({ hasSoul: true, soulPath: path });
  });
  it('drops only newly added history without a soul, including after deletion', async () => {
    const restored: ExtendedUIMessage = {
      id: 'restored',
      role: 'assistant',
      parts: [],
    };
    const history = [restored];
    const { ext, path } = fixture(history);
    await ext.onStart?.();
    for (const content of ['', '  ', '<soul></soul>']) {
      writeFileSync(path, content);
      history.push({ id: 'discarded', role: 'user', parts: [] });
      expect(ext.shouldRunStep?.(history)).toBe(false);
      expect(history).toEqual([restored]);
    }
    writeFileSync(path, 'I help with precision.');
    history.push({ id: 'accepted', role: 'user', parts: [] });
    expect(ext.shouldRunStep?.(history)).toBe(true);
    await ext.onStepComplete?.({} as never);
    rmSync(path);
    history.splice(1, 0, { id: 'discarded-insert', role: 'user', parts: [] });
    history.push({ id: 'discarded-after-deletion', role: 'user', parts: [] });
    expect(ext.shouldRunStep?.(history)).toBe(false);
    expect(history.map((message) => message.id)).toEqual([
      'restored',
      'accepted',
    ]);
  });
});
