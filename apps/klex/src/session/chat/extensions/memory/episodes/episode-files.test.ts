import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { EpisodeRotationConfig } from '@/config';

import { EpisodeStore } from './episode-files';
import { HEADER_LINE, output, outputTexts, recordLine } from './test-utils';

const T0 = Date.parse('2026-01-02T10:00:00Z');
const MINUTE = 60_000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(overrides: Partial<EpisodeRotationConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klex-episodes-'));
  directories.push(root);
  const limits: EpisodeRotationConfig = {
    maxCharacters: 50_000,
    maxDurationMs: 60 * MINUTE,
    idleTimeoutMs: 10 * MINUTE,
    ...overrides,
  };
  const logger = { warn: vi.fn() } as unknown as ModuleLogger;
  const onCompleted = vi.fn();
  const store = new EpisodeStore({
    episodicDir: root,
    getLimits: () => limits,
    logger,
    onCompleted,
  });
  const files = async (date = '2026-01-02'): Promise<string[]> => {
    try {
      return (await readdir(join(root, date))).sort(byIndex);
    } catch {
      return [];
    }
  };
  const content = (file: string, date = '2026-01-02') =>
    readFile(join(root, date, file), 'utf-8');
  return { root, limits, store, files, content, onCompleted };
}

function byIndex(left: string, right: string): number {
  return Number.parseInt(left, 10) - Number.parseInt(right, 10);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

describe('EpisodeStore', () => {
  it('notifies for every successful rotation and closes idle episodes only once', async () => {
    const { store, onCompleted, content } = await harness({
      maxCharacters: 200,
    });
    await store.append(
      [output('a'.repeat(300)), output('b'.repeat(300)), output('c')],
      T0,
    );
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(await content('1-10-00.jsonl')).toContain('a'.repeat(300));
    await store.closeIdle(T0 + 9 * MINUTE);
    expect(onCompleted).toHaveBeenCalledTimes(2);
    await store.closeIdle(T0 + 10 * MINUTE);
    await store.closeIdle(T0 + 11 * MINUTE);
    expect(onCompleted).toHaveBeenCalledTimes(3);
    expect(await store.readOpenEpisode()).toBeNull();
  });

  it('does not notify a successful completion for a failed append', async () => {
    const { root, store, onCompleted } = await harness();
    await store.append([output('one')], T0);
    const path = join(root, '2026-01-02', '1-10-00.jsonl');
    await rm(path);
    await mkdir(path);
    await expect(store.append([output('two')], T0 + MINUTE)).rejects.toThrow();
    expect(onCompleted).not.toHaveBeenCalled();
  });
  it('creates no file before the first append', async () => {
    const { store, files, root } = await harness();
    await store.observeActivity(T0);
    await store.append([], T0);
    expect(await readdir(root)).toEqual([]);
    expect(await files()).toEqual([]);
    expect(store.introspect()).toBeNull();
  });

  it('writes a header line and one JSON line per record', async () => {
    const { store, files, content } = await harness();
    await store.append([output('plan'), output('reply', 'm2')], T0);
    await store.append([output('done', 'm3')], T0 + MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl']);
    const text = await content('1-10-00.jsonl');
    expect(text).toBe(
      HEADER_LINE +
        recordLine(output('plan'), iso(T0)) +
        recordLine(output('reply', 'm2'), iso(T0)) +
        recordLine(output('done', 'm3'), iso(T0 + MINUTE)),
    );
    expect(store.introspect()).toMatchObject({
      characters: text.length,
      createdAt: T0,
      lastActivityAt: T0 + MINUTE,
    });
  });

  it('puts the record that crosses the size limit into a new episode', async () => {
    const first = output('a'.repeat(20));
    const second = output('b'.repeat(20));
    // Header + one line fits; the second line would cross the limit.
    const oneRecord = HEADER_LINE.length + recordLine(first, iso(T0)).length;
    const { store, files, content } = await harness({
      maxCharacters: oneRecord + 5,
    });
    await store.append([first, second], T0);
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-00.jsonl']);
    expect(await content('1-10-00.jsonl')).toBe(
      HEADER_LINE + recordLine(first, iso(T0)),
    );
    expect(await content('2-10-00.jsonl')).toBe(
      HEADER_LINE + recordLine(second, iso(T0)),
    );
  });

  it('gives an oversized record an episode of its own', async () => {
    const { store, files, content } = await harness({ maxCharacters: 200 });
    const huge = output('x'.repeat(300));
    await store.append([output('small'), huge, output('after')], T0);
    expect(await files()).toEqual([
      '1-10-00.jsonl',
      '2-10-00.jsonl',
      '3-10-00.jsonl',
    ]);
    expect(await content('2-10-00.jsonl')).toBe(
      HEADER_LINE + recordLine(huge, iso(T0)),
    );
    expect(outputTexts(await content('3-10-00.jsonl'))).toEqual(['after']);
  });

  it('rotates after the maximum duration', async () => {
    const { store, files } = await harness({ maxDurationMs: 30 * MINUTE });
    for (let minute = 0; minute <= 30; minute += 5) {
      await store.append([output(`m${minute}`)], T0 + minute * MINUTE);
    }
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-30.jsonl']);
  });

  it('rotates after an idle gap', async () => {
    const { store, files } = await harness();
    await store.append([output('one')], T0);
    await store.append([output('two')], T0 + 9 * MINUTE);
    await store.append([output('three')], T0 + 19 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-19.jsonl']);
  });

  it('rotates on a UTC date change', async () => {
    const { store, files } = await harness();
    const late = Date.parse('2026-01-02T23:58:00Z');
    await store.append([output('late')], late);
    await store.append([output('early')], late + 4 * MINUTE);
    expect(await files('2026-01-02')).toEqual(['1-23-58.jsonl']);
    expect(await files('2026-01-03')).toEqual(['1-00-02.jsonl']);
  });

  it('observeActivity after a gap rotates; regular calls keep the episode open', async () => {
    const { store, files } = await harness();
    await store.append([output('start')], T0);
    // A long step: activity every 5 minutes, no records for 25 minutes.
    for (let minute = 5; minute <= 25; minute += 5) {
      await store.observeActivity(T0 + minute * MINUTE);
    }
    await store.append([output('same episode')], T0 + 26 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl']);

    await store.observeActivity(T0 + 40 * MINUTE);
    expect(store.introspect()).toBeNull();
    await store.append([output('after gap')], T0 + 41 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-41.jsonl']);
  });

  it('extendActivity keeps a long step in one episode', async () => {
    const { store, files } = await harness();
    await store.append([output('before')], T0);
    await store.observeActivity(T0 + MINUTE);
    // The step runs for 15 minutes, longer than the idle timeout.
    await store.extendActivity(T0 + 16 * MINUTE);
    await store.append([output('step result')], T0 + 16 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl']);
  });

  it('starts a new episode after a failed write', async () => {
    const { root, store, files, content } = await harness();
    await store.append([output('one')], T0);
    // Make the open episode unwritable: appendFile on a directory fails.
    const path = join(root, '2026-01-02', '1-10-00.jsonl');
    await rm(path);
    await mkdir(path);
    await expect(store.append([output('two')], T0 + MINUTE)).rejects.toThrow();
    expect(store.introspect()).toBeNull();
    await store.append([output('two')], T0 + 2 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-02.jsonl']);
    expect(outputTexts(await content('2-10-02.jsonl'))).toEqual(['two']);
  });

  it('re-reads limits on each append', async () => {
    const { store, files, limits } = await harness();
    await store.append([output('one')], T0);
    await store.append([output('two')], T0 + MINUTE);
    limits.idleTimeoutMs = 30_000;
    await store.append([output('three')], T0 + 2 * MINUTE);
    expect(await files()).toEqual(['1-10-00.jsonl', '2-10-02.jsonl']);
  });

  it('never reuses an existing index, including legacy Markdown episodes', async () => {
    const { root, store, files, content } = await harness();
    await mkdir(join(root, '2026-01-02'));
    await writeFile(join(root, '2026-01-02', '1-09-00.jsonl'), 'previous');
    await writeFile(join(root, '2026-01-02', '4-09-30.md'), 'legacy');
    await store.append([output('fresh')], T0);
    expect(await files()).toEqual([
      '1-09-00.jsonl',
      '4-09-30.md',
      '5-10-00.jsonl',
    ]);
    expect(await content('1-09-00.jsonl')).toBe('previous');
  });

  it('keeps order across concurrent appends', async () => {
    const { store, content } = await harness();
    await Promise.all([
      store.append([output('a1'), output('a2')], T0),
      store.observeActivity(T0),
      store.append([output('b1')], T0),
      store.append([output('c1'), output('c2')], T0),
    ]);
    expect(outputTexts(await content('1-10-00.jsonl'))).toEqual([
      'a1',
      'a2',
      'b1',
      'c1',
      'c2',
    ]);
  });
});
