import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

import type { ExtendedUIMessage } from '../../message-types';
import type {
  Extension,
  ExtensionDeps,
  StepCompleteEvent,
} from '../extension-api';
import { outputTexts } from './episodes/test-utils';
import { createMemoryExt } from './memory';

vi.mock('./system-prompt-part.md', () => ({ default: 'Memory.' }));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));

const coordinator = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  setMainTurnActive: vi.fn(),
  observe: vi.fn(() => true),
  introspect: vi.fn(() => ({})),
}));

vi.mock('./retrieval', () => ({
  createMemoryRetrievalCoordinator: () => coordinator,
  recallInputSchema: z.object({}),
  RecallRejectedError: class extends Error {},
  renderObservation: () => ({ text: '', cursor: null, hasMore: false }),
}));

const success = {
  shouldContinue: false,
  fatalError: false,
  generationFailed: false,
  modelFallbackOccurred: false,
} as StepCompleteEvent;
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function message(id: string, text: string): ExtendedUIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'klex-memory-ext-'));
  directories.push(dataDir);
  const history: ExtendedUIMessage[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const episodes = {
    maxCharacters: 50_000,
    maxDurationMs: 3_600_000,
    idleTimeoutMs: 600_000,
  };
  const deps = {
    getDataDir: () => dataDir,
    getHistory: () => history,
    config: { get: () => ({ extensions: { memory: { episodes } } }) },
    logger,
  } as unknown as ExtensionDeps;
  const extension = createMemoryExt().create(deps) as Extension;
  const recorded = async (): Promise<string[]> => {
    const root = join(dataDir, 'episodic');
    const texts: string[] = [];
    for (const date of await readdir(root).catch(() => [])) {
      for (const file of (await readdir(join(root, date))).sort()) {
        texts.push(
          ...outputTexts(await readFile(join(root, date, file), 'utf-8')),
        );
      }
    }
    return texts;
  };
  const cursor = () => {
    const state = extension.introspect?.() as
      | { recorder: { cursor: unknown } | null }
      | undefined;
    return state?.recorder?.cursor ?? null;
  };
  return { extension, history, recorded, cursor };
}

describe('memory extension lifecycle', () => {
  it('records the history after each successful step', async () => {
    const { extension, history, recorded } = await harness();
    await extension.onStart?.();
    extension.onStepStart?.();
    history.push(message('a1', 'first'));
    await extension.onStepComplete?.(success);
    extension.onStepStart?.();
    history.push(message('a2', 'second'));
    await extension.onStepComplete?.(success);
    expect(await recorded()).toEqual(['first', 'second']);
    await extension.onClose?.();
  });

  it('skips failed steps and records their history on the next success', async () => {
    const { extension, history, recorded } = await harness();
    await extension.onStart?.();
    extension.onStepStart?.();
    history.push(message('a1', 'first'));
    await extension.onStepComplete?.({ ...success, generationFailed: true });
    expect(await recorded()).toEqual([]);
    extension.onStepStart?.();
    await extension.onStepComplete?.(success);
    expect(await recorded()).toEqual(['first']);
    await extension.onClose?.();
  });

  it('flushes on close, closes retrieval, and ignores later steps', async () => {
    const { extension, history, recorded } = await harness();
    await extension.onStart?.();
    history.push(message('a1', 'pending'));
    await extension.onClose?.();
    expect(coordinator.close).toHaveBeenCalled();
    expect(await recorded()).toEqual(['pending']);
    history.push(message('a2', 'late'));
    await extension.onStepComplete?.(success);
    expect(await recorded()).toEqual(['pending']);
  });

  it('flushes on the interval only between steps', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { extension, history, cursor } = await harness();
    await extension.onStart?.();
    extension.onStepStart?.();
    history.push(message('a1', 'during step'));
    vi.advanceTimersByTime(30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cursor()).toBeNull();

    await extension.onStepComplete?.({ ...success, fatalError: true });
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(cursor()).toEqual({ id: 'a1', index: 0 }));
    await extension.onClose?.();
  });
});
