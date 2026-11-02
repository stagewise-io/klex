import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { createActivityFixture } from '@/activity-history/test-support';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import type {
  Extension,
  ExtensionDeps,
  StepCompleteEvent,
} from '../extension-api';
import { createMemoryExt } from './memory';

vi.mock('./system-prompt-part.md', () => ({ default: 'Memory.' }));
const coordinator = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  setMainTurnActive: vi.fn(),
  observe: vi.fn((_input: { text: string }) => true),
  remember: vi.fn(),
  introspect: vi.fn(() => ({})),
}));
vi.mock('./retrieval', async () => ({
  createMemoryRetrievalCoordinator: () => coordinator,
  recallInputSchema: z.object({}),
  RecallRejectedError: class extends Error {},
  renderObservation: (await import('./retrieval/observation-view'))
    .renderObservation,
}));

const success = {
  shouldContinue: false,
  fatalError: false,
  generationFailed: false,
  modelFallbackOccurred: false,
  requestRejected: false,
} as StepCompleteEvent;
const fixtures: Awaited<ReturnType<typeof createActivityFixture>>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  coordinator.observe.mockReturnValue(true);
});
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
function message(id: string, text: string): ExtendedUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
async function harness() {
  const fixture = await createActivityFixture();
  fixtures.push(fixture);
  const history: ExtendedUIMessage[] = [];
  const extension = createMemoryExt({ activities: fixture.activities }).create({
    getDataDir: () => fixture.directory,
    getHistory: () => history,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExtensionDeps) as Extension;
  return { extension, history, fixture };
}

describe('memory extension lifecycle', () => {
  it('owns only retrieval, never a transcript copy or episode publisher', async () => {
    const { extension, history, fixture } = await harness();
    await extension.onStart?.();
    await extension.onStart?.();
    expect(coordinator.start).toHaveBeenCalledOnce();
    extension.onStepStart?.();
    history.push(message('a1', 'remember this result'));
    await extension.onStepComplete?.(success);
    expect(coordinator.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('remember this result'),
      }),
    );
    await extension.onClose?.();
    expect(coordinator.close).toHaveBeenCalledOnce();
    expect(await fixture.activities.manifest()).toEqual([]);
    expect(await readdir(fixture.directory)).not.toContain('episodic');
    expect(extension.introspect?.()).not.toHaveProperty('recorder');
  });

  it('seeds observation at the restored window end without replay', async () => {
    const { extension, history } = await harness();
    history.push(message('restored', 'old result'));
    await extension.onStart?.();
    extension.onStepStart?.();
    expect(coordinator.observe).not.toHaveBeenCalled();
    history.push(message('new', 'new result'));
    await extension.onStepComplete?.(success);
    expect(coordinator.observe).toHaveBeenCalledOnce();
    expect(coordinator.observe.mock.calls[0]?.[0]).toEqual({
      text: expect.stringContaining('new result'),
    });
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'new',
    });
    await extension.onClose?.();
  });

  it('tracks continuing and throwing steps without leaving retrieval paused', async () => {
    const { extension } = await harness();
    await extension.onStart?.();
    extension.onStepStart?.();
    expect(coordinator.setMainTurnActive).toHaveBeenLastCalledWith(true);
    await extension.onStepComplete?.({ ...success, shouldContinue: true });
    expect(coordinator.setMainTurnActive).toHaveBeenLastCalledWith(true);
    await extension.onStepComplete?.({ ...success, fatalError: true });
    expect(coordinator.setMainTurnActive).toHaveBeenLastCalledWith(false);
    expect(extension.introspect?.()).toMatchObject({ stepActive: false });
    await extension.onClose?.();
  });

  it('does not lose undelivered observations when the child is unavailable', async () => {
    const { extension, history } = await harness();
    await extension.onStart?.();
    history.push(message('a1', 'waiting result'));
    coordinator.observe.mockReturnValue(false);
    await extension.onStepComplete?.(success);
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: null,
    });
    coordinator.observe.mockReturnValue(true);
    await extension.onStepComplete?.(success);
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'a1',
    });
    await extension.onClose?.();
  });

  it('preserves the observation cursor around staged and applied checkpoints', async () => {
    const { extension, history } = await harness();
    await extension.onStart?.();
    history.push(message('a1', 'first result'), message('a2', 'second result'));
    expect(
      await extension.onCheckpointApplying?.({
        droppedMessageIds: ['a1', 'a2'],
        checkpointMessageId: 'cp',
      }),
    ).toBeUndefined();
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'a2',
    });
    await extension.onCheckpointApplying?.({
      droppedMessageIds: ['a1', 'a2'],
      checkpointMessageId: 'aborted',
    });
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'a2',
    });
    await extension.onCheckpointApplying?.({
      droppedMessageIds: ['a1', 'a2'],
      checkpointMessageId: 'cp2',
    });
    history.splice(0, 2, message('cp2', 'header'));
    history.push(message('a3', 'third result'));
    extension.onStepStart?.();
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'a3',
    });
    expect(coordinator.observe).toHaveBeenLastCalledWith({
      text: expect.stringContaining('third result'),
    });
    await extension.onClose?.();
  });

  it('isolates observation failure and retries on a later step', async () => {
    const { extension, history } = await harness();
    await extension.onStart?.();
    history.push(message('a1', 'pending result'));
    coordinator.observe.mockImplementationOnce(() => {
      throw new Error('child unavailable');
    });
    await expect(extension.onStepComplete?.(success)).resolves.toBeUndefined();
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: null,
    });
    await extension.onStepComplete?.(success);
    expect(extension.introspect?.()).toMatchObject({
      lastObservedMessageId: 'a1',
    });
    await extension.onClose?.();
  });

  it('ignores steps after close and does not close the injected history', async () => {
    const { extension, history, fixture } = await harness();
    await extension.onStart?.();
    await extension.onClose?.();
    history.push(message('late', 'late result'));
    extension.onStepStart?.();
    await extension.onStepComplete?.(success);
    expect(coordinator.observe).not.toHaveBeenCalled();
    expect(fixture.activities.isAvailable()).toBe(true);
    expect(extension.getTools?.({} as never)).toEqual({});
  });
});
