import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  async function setup() {
    const { directory, path } = fixture();
    const logger = { warn: vi.fn() };
    const soul = createSoul({
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
    });
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
    return { soul, directory, path, logger };
  }

  it('clears persisted failure status after saving a soul', async () => {
    const { soul, directory } = await setup();
    expect((await soul.getStatus()).failure?.category).toBe('auth');
    await expect(soul.create('Create a soul')).resolves.toBe('Saved soul');
    expect(soul.get()).toBe('Saved soul');
    expect((await state.readSoulState(directory))?.payload.failure).toBeNull();
    expect(await soul.getStatus()).toEqual({ failure: null });
  });

  it('returns the saved soul and warns when clearing failure status fails', async () => {
    const { soul, directory, logger } = await setup();
    const error = new Error('State write failed');
    vi.spyOn(state, 'writeSoulFailure').mockRejectedValueOnce(error);
    await expect(soul.create('Create a soul')).resolves.toBe('Saved soul');
    expect(soul.get()).toBe('Saved soul');
    expect(
      (await state.readSoulState(directory))?.payload.failure?.category,
    ).toBe('auth');
    expect(await soul.getStatus()).toEqual({ failure: null });
    expect(logger.warn).toHaveBeenCalledWith(
      { error },
      'Soul saved but failed to clear generation failure status',
    );
  });

  it('ignores stale failure status when a soul already exists', async () => {
    const { soul, path } = await setup();
    writeFileSync(path, 'Existing soul');
    expect(await soul.getStatus()).toEqual({ failure: null });
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
