import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '../../message-types';
import type { ExtensionDeps } from '../extension-api';
import { createSoulExt, readSoul } from './soul';

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
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
