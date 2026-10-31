import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { serializeSkill } from './skill-format';
import { createSkillRegistry, SkillValidationError } from './skills';
import { MAX_METADATA_BYTES } from './skills-config';

const directories: string[] = [];
const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as ModuleLogger;

afterEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-skill-registry-'));
  directories.push(directory);
  return directory;
}

async function started(directory?: string) {
  const dir = directory ?? (await dataDirectory());
  const registry = createSkillRegistry({ dataDirectory: dir, logger });
  await registry.start();
  return { registry, dir };
}

async function readRegistryFile(dir: string) {
  return JSON.parse(
    await readFile(join(dir, 'skills', 'registry.json'), 'utf8'),
  ) as {
    turn: number;
    skills: Record<string, Record<string, unknown>>;
  };
}

const content = { description: 'Fix the build.', body: 'Run pnpm build.' };

describe('skill registry namespaces', () => {
  it('rejects invalid, reserved and foreign-owned namespaces', async () => {
    const { registry } = await started();
    expect(() => registry.claimNamespace('a', 'Bad_Name')).toThrow(/Invalid/);
    expect(() => registry.claimNamespace('a', 'user')).toThrow(/reserved/);
    registry.claimNamespace('a', 'learning');
    registry.claimNamespace('a', 'learning');
    expect(() => registry.claimNamespace('b', 'learning')).toThrow(
      /already claimed by "a"/,
    );
    expect(() => registry.forNamespace('other')).toThrow(/not claimed/);
  });

  it('isolates handles by namespace and qualifies ids', async () => {
    const { registry, dir } = await started();
    registry.claimNamespace('a', 'alpha');
    registry.claimNamespace('b', 'beta');
    const alpha = registry.forNamespace('alpha');
    const beta = registry.forNamespace('beta');

    const skill = await alpha.put('fix-build', content);
    expect(skill).toMatchObject({ id: 'alpha/fix-build', namespace: 'alpha' });
    expect(beta.get('fix-build')).toBeNull();
    expect(beta.list()).toEqual([]);
    expect(await beta.delete('fix-build')).toBe(false);
    expect(alpha.get('fix-build')).not.toBeNull();
    expect(
      await readFile(
        join(dir, 'skills', 'alpha', 'fix-build', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: "fix-build"');
  });

  it('resolves bare names to zero, one or many skills', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    registry.claimNamespace('b', 'beta');
    await registry.forNamespace('alpha').put('shared', content);
    await registry.forNamespace('beta').put('shared', content);
    await registry.forNamespace('beta').put('unique', content);
    expect(registry.resolveName('missing')).toEqual([]);
    expect(registry.resolveName('unique').map((skill) => skill.id)).toEqual([
      'beta/unique',
    ]);
    expect(registry.resolveName('shared').map((skill) => skill.id)).toEqual([
      'alpha/shared',
      'beta/shared',
    ]);
    expect(registry.list().map((skill) => skill.id)).toEqual([
      'alpha/shared',
      'beta/shared',
      'beta/unique',
    ]);
  });
});

describe('skill registry usage', () => {
  it('moves updated* only on content changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    const handle = registry.forNamespace('alpha');
    await handle.put('fix-build', content);
    registry.tick();

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    await handle.put('fix-build', { ...content, body: ` ${content.body} ` });
    await handle.setMetadata('fix-build', { sourceEpisodes: ['e1'] });
    expect(handle.get('fix-build')).toMatchObject({
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedTurn: 0,
      metadata: { sourceEpisodes: ['e1'] },
    });

    await handle.put('fix-build', { ...content, body: 'New body.' });
    expect(handle.get('fix-build')).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      createdTurn: 0,
      updatedTurn: 1,
      metadata: { sourceEpisodes: ['e1'] },
    });
  });

  it('sets userEdited on admin edits and resets it on namespace edits', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    const handle = registry.forNamespace('alpha');
    await handle.put('fix-build', content);
    const edited = await registry.update('alpha/fix-build', {
      body: 'Edited.',
    });
    expect(edited).toMatchObject({ body: 'Edited.', userEdited: true });
    await handle.put('fix-build', { ...content, body: 'Edited.' });
    expect(handle.get('fix-build')?.userEdited).toBe(true);
    await handle.put('fix-build', content);
    expect(handle.get('fix-build')?.userEdited).toBe(false);
    expect(await registry.update('alpha/missing', { body: 'x' })).toBeNull();
    await expect(
      registry.update('alpha/fix-build', { description: ' ' }),
    ).rejects.toThrow(SkillValidationError);
  });

  it('applies seeds only on create and keeps turns at the clock', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    registry.tick();
    registry.tick();
    const handle = registry.forNamespace('alpha');
    const seed = {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-02-01T00:00:00.000Z',
      lastReadAt: '2025-03-01T00:00:00.000Z',
      readCount: 4,
      userEdited: true,
    };
    await handle.put('fix-build', content, { seed });
    expect(handle.get('fix-build')).toMatchObject({
      ...seed,
      createdTurn: 2,
      updatedTurn: 2,
      lastReadTurn: 2,
    });
    await handle.put('fix-build', content, {
      seed: { ...seed, readCount: 99 },
    });
    expect(handle.get('fix-build')?.readCount).toBe(4);
  });

  it('rejects oversized or non-object metadata', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    const handle = registry.forNamespace('alpha');
    await expect(
      handle.put('fix-build', content, {
        metadata: { blob: 'x'.repeat(MAX_METADATA_BYTES) },
      }),
    ).rejects.toThrow(SkillValidationError);
    expect(handle.get('fix-build')).toBeNull();
    await handle.put('fix-build', content);
    await expect(
      handle.setMetadata('fix-build', [] as unknown as Record<string, unknown>),
    ).rejects.toThrow(SkillValidationError);
    expect(await handle.setMetadata('missing', {})).toBeNull();
  });

  it('records reads', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    await registry.forNamespace('alpha').put('fix-build', content);
    registry.tick();
    await registry.recordRead('alpha/fix-build');
    await registry.recordRead('alpha/missing');
    expect(registry.get('alpha/fix-build')).toMatchObject({
      readCount: 1,
      lastReadTurn: 1,
    });
    expect(registry.read('alpha/fix-build')).toContain('Run pnpm build.');
  });
});

describe('skill registry persistence', () => {
  it('creates usage lazily for documents without bookkeeping and prunes orphans', async () => {
    const dir = await dataDirectory();
    const folder = join(dir, 'skills', 'alpha', 'restored');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'SKILL.md'),
      serializeSkill({ name: 'restored', ...content }),
    );
    const first = await started(dir);
    first.registry.claimNamespace('a', 'alpha');
    await first.registry.forNamespace('alpha').put('gone', content);
    await rm(join(dir, 'skills', 'alpha', 'gone'), { recursive: true });

    const second = await started(dir);
    expect(second.registry.get('alpha/gone')).toBeNull();
    expect(second.registry.get('alpha/restored')).toMatchObject({
      readCount: 0,
      createdTurn: 0,
    });
    await second.registry.recordRead('alpha/restored');
    expect(Object.keys((await readRegistryFile(dir)).skills)).toEqual([
      'alpha/restored',
    ]);
  });

  it('persists the clock lazily and on close', async () => {
    const { registry, dir } = await started();
    registry.claimNamespace('a', 'alpha');
    await registry.forNamespace('alpha').put('fix-build', content);
    registry.tick();
    expect((await readRegistryFile(dir)).turn).toBe(0);
    await registry.recordRead('alpha/fix-build');
    expect((await readRegistryFile(dir)).turn).toBe(1);
    registry.tick();
    await registry.close();
    expect((await readRegistryFile(dir)).turn).toBe(2);

    const reopened = await started(dir);
    expect(reopened.registry.currentTurn()).toBe(2);
    expect(reopened.registry.get('alpha/fix-build')).toMatchObject({
      readCount: 1,
      lastReadTurn: 1,
    });
  });

  it('preserves unknown fields', async () => {
    const { registry, dir } = await started();
    registry.claimNamespace('a', 'alpha');
    await registry.forNamespace('alpha').put('fix-build', content);
    const file = JSON.parse(
      await readFile(join(dir, 'skills', 'registry.json'), 'utf8'),
    );
    file.future = { kept: true };
    file.skills['alpha/fix-build'].future = 1;
    await writeFile(join(dir, 'skills', 'registry.json'), JSON.stringify(file));

    const reopened = await started(dir);
    await reopened.registry.recordRead('alpha/fix-build');
    const written = JSON.parse(
      await readFile(join(dir, 'skills', 'registry.json'), 'utf8'),
    );
    expect(written.future).toEqual({ kept: true });
    expect(written.skills['alpha/fix-build'].future).toBe(1);
  });

  it('serializes concurrent mutations in call order', async () => {
    const { registry } = await started();
    registry.claimNamespace('a', 'alpha');
    const handle = registry.forNamespace('alpha');
    await Promise.all([
      handle.put('fix-build', content),
      registry.update('alpha/fix-build', { body: 'Admin.' }),
      handle.setMetadata('fix-build', { n: 1 }),
      registry.recordRead('alpha/fix-build'),
    ]);
    expect(handle.get('fix-build')).toMatchObject({
      body: 'Admin.',
      userEdited: true,
      readCount: 1,
      metadata: { n: 1 },
    });
    expect(await registry.delete('alpha/fix-build')).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});
