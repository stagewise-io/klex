import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ResourceSnapshot } from './resource-handlers';
import {
  DEFAULT_RESOURCE_WINDOW_CONFIG,
  ResourceWindowManager,
  type ResourceWindowUpdateOutcome,
} from './resource-window-manager';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as unknown as ModuleLogger;

function makeSnapshot(uri: string, text: string): ResourceSnapshot {
  return {
    uri,
    mimeType: 'text/plain',
    contents: {
      contents: [{ uri, mimeType: 'text/plain', text }],
    },
  };
}

function createManager(
  overrides: Partial<{
    onUnsubscribe: (namespace: string, uri: string) => void;
    onUpdateFired: (
      handle: string,
      generation: number,
      namespace: string,
      uri: string,
      old: ResourceSnapshot,
    ) => Promise<ResourceWindowUpdateOutcome>;
  }> = {},
) {
  const onUnsubscribe = vi.fn(overrides.onUnsubscribe ?? (() => {}));
  const onUpdateFired = vi.fn(
    overrides.onUpdateFired ??
      (async (
        _handle: string,
        _generation: number,
        _namespace: string,
        uri: string,
      ) => ({
        kind: 'updated' as const,
        snapshot: makeSnapshot(uri, 'updated'),
      })),
  );
  const manager = new ResourceWindowManager({
    config: {
      ...DEFAULT_RESOURCE_WINDOW_CONFIG,
      maxConcurrentWindows: 3,
      maxEventsPerWindow: 2,
      rateLimitWindowMs: 60_000,
    },
    logger: mockLogger,
    onUnsubscribe,
    onUpdateFired,
  });
  return { manager, onUnsubscribe, onUpdateFired };
}

describe('ResourceWindowManager: lifecycle', () => {
  it('allocates stable monotonically increasing handles without reuse', () => {
    const { manager } = createManager();
    const first = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'a'),
      { live: false },
    );
    expect(first).toMatchObject({ handle: 'r1', generation: 1, live: false });
    expect(manager.closeWindow(first.handle)).toBe(true);

    const second = manager.openWindow(
      'server',
      'file:///b',
      makeSnapshot('file:///b', 'b'),
      { live: false },
    );
    expect(second.handle).toBe('r2');
  });

  it('reuses a handle and increments its generation for an exact reopen', () => {
    const { manager, onUnsubscribe } = createManager();
    const first = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    const reopened = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'new'),
      { live: true },
    );

    expect(reopened).toMatchObject({ handle: first.handle, generation: 2 });
    expect(manager.getOpenWindows()).toHaveLength(1);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('navigates a handle across servers and releases the previous live target', () => {
    const { manager, onUnsubscribe } = createManager();
    const first = manager.openWindow(
      'one',
      'file:///a',
      makeSnapshot('file:///a', 'a'),
      { live: true },
    );
    const navigated = manager.openWindow(
      'two',
      'custom:item?cursor=2',
      makeSnapshot('custom:item?cursor=2', 'b'),
      { handle: first.handle, live: true },
    );

    expect(navigated).toMatchObject({
      handle: first.handle,
      generation: 2,
      namespace: 'two',
      uri: 'custom:item?cursor=2',
    });
    expect(onUnsubscribe).toHaveBeenCalledWith('one', 'file:///a');
  });

  it('tracks non-live windows and closes without unsubscribing', () => {
    const { manager, onUnsubscribe } = createManager();
    const window = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'a'),
      { live: false },
    );

    expect(manager.getOpenWindows()).toEqual([
      expect.objectContaining({ handle: window.handle, live: false }),
    ]);
    expect(manager.closeWindow(window.handle)).toBe(true);
    expect(manager.closeWindow(window.handle)).toBe(false);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('rejects unknown handles and destinations owned by another handle', () => {
    const { manager } = createManager();
    const first = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'a'),
      { live: false },
    );
    const second = manager.openWindow(
      'server',
      'file:///b',
      makeSnapshot('file:///b', 'b'),
      { live: false },
    );

    expect(() =>
      manager.openWindow(
        'server',
        'file:///c',
        makeSnapshot('file:///c', 'c'),
        { handle: 'r999', live: false },
      ),
    ).toThrow("Unknown resource handle 'r999'");
    expect(() =>
      manager.openWindow(
        'server',
        'file:///a',
        makeSnapshot('file:///a', 'a'),
        { handle: second.handle, live: false },
      ),
    ).toThrow(`already open as '${first.handle}'`);
  });

  it('stops all windows and only unsubscribes live targets', () => {
    const { manager, onUnsubscribe } = createManager();
    manager.openWindow('server', 'file:///a', makeSnapshot('file:///a', 'a'), {
      live: true,
    });
    manager.openWindow('server', 'file:///b', makeSnapshot('file:///b', 'b'), {
      live: false,
    });

    manager.stopAll();
    expect(manager.getOpenWindows()).toHaveLength(0);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    expect(onUnsubscribe).toHaveBeenCalledWith('server', 'file:///a');
  });

  it('throws at capacity instead of evicting', () => {
    const { manager, onUnsubscribe } = createManager();
    for (const name of ['a', 'b', 'c']) {
      manager.openWindow(
        'server',
        `file:///${name}`,
        makeSnapshot(`file:///${name}`, name),
        { live: true },
      );
    }
    expect(() =>
      manager.openWindow(
        'server',
        'file:///d',
        makeSnapshot('file:///d', 'd'),
        { live: true },
      ),
    ).toThrow('Resource window limit reached (3)');
    expect(manager.getOpenWindows()).toHaveLength(3);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });
});

describe('ResourceWindowManager: updates', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('routes notifications only to the matching live window', async () => {
    const { manager, onUpdateFired } = createManager();
    const window = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    manager.openWindow(
      'server',
      'file:///b',
      makeSnapshot('file:///b', 'old'),
      { live: false },
    );

    manager.onResourceUpdate('server', 'file:///a');
    manager.onResourceUpdate('server', 'file:///b');
    await vi.advanceTimersByTimeAsync(2_100);

    expect(onUpdateFired).toHaveBeenCalledTimes(1);
    expect(onUpdateFired).toHaveBeenCalledWith(
      window.handle,
      window.generation,
      'server',
      'file:///a',
      expect.anything(),
    );
  });

  it('coalesces rapid notifications', async () => {
    const { manager, onUpdateFired } = createManager();
    manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    manager.onResourceUpdate('server', 'file:///a');
    manager.onResourceUpdate('server', 'file:///a');
    manager.onResourceUpdate('server', 'file:///a');

    await vi.advanceTimersByTimeAsync(2_100);
    expect(onUpdateFired).toHaveBeenCalledTimes(1);
  });

  it('ignores an in-flight result after navigation changes the generation', async () => {
    const refresh = Promise.withResolvers<ResourceWindowUpdateOutcome>();
    const { manager } = createManager({
      onUpdateFired: async () => refresh.promise,
    });
    const first = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    manager.onResourceUpdate('server', 'file:///a');
    await vi.advanceTimersByTimeAsync(2_100);

    manager.openWindow(
      'server',
      'file:///b',
      makeSnapshot('file:///b', 'navigated'),
      { handle: first.handle, live: true },
    );
    refresh.resolve({
      kind: 'updated',
      snapshot: makeSnapshot('file:///a', 'stale'),
    });
    await Promise.resolve();

    expect(manager.getSnapshot(first.handle)?.uri).toBe('file:///b');
  });

  it('cancels a scheduled retry when the window is closed', async () => {
    const { manager, onUpdateFired } = createManager({
      onUpdateFired: async () => ({ kind: 'retry', retryAfterMs: 1_000 }),
    });
    const window = manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    manager.onResourceUpdate('server', 'file:///a');
    await vi.advanceTimersByTimeAsync(2_100);
    manager.closeWindow(window.handle);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(onUpdateFired).toHaveBeenCalledTimes(1);
  });

  it('closes a deleted window', async () => {
    const { manager, onUnsubscribe } = createManager({
      onUpdateFired: async () => ({ kind: 'deleted' }),
    });
    manager.openWindow(
      'server',
      'file:///a',
      makeSnapshot('file:///a', 'old'),
      { live: true },
    );
    manager.onResourceUpdate('server', 'file:///a');
    await vi.advanceTimersByTimeAsync(2_100);

    expect(manager.getOpenWindows()).toHaveLength(0);
    expect(onUnsubscribe).toHaveBeenCalledWith('server', 'file:///a');
  });
});
