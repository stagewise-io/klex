import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderOperationResult,
  ProviderVoiceList,
  ProviderVoicePreview,
} from './provider-registry';
import { createVoiceOperations } from './voice-operations';

const list: ProviderVoiceList = { voices: [], defaultVoiceId: 'original' };
const audio: ProviderVoicePreview = {
  audio: new Uint8Array(48),
  mimeType: 'audio/wav',
  sourceModelId: 'model',
  mode: 'live',
};
const ok = <T>(value: T): ProviderOperationResult<T> => ({
  ok: true,
  code: 'available',
  value,
});
afterEach(() => vi.useRealTimers());

describe('voice operations', () => {
  it('deduplicates discovery and returns detached cached data', async () => {
    const operations = createVoiceOperations();
    const hook = vi.fn(async () => ok(list));
    await Promise.all([
      operations.list('p', 's', 'm', false, hook),
      operations.list('p', 's', 'm', false, hook),
    ]);
    const result = await operations.list('p', 's', 'm', false, hook);
    if (result.ok) result.value.defaultVoiceId = 'mutated';
    expect(await operations.list('p', 's', 'm', false, hook)).toEqual(ok(list));
    expect(hook).toHaveBeenCalledTimes(1);
    operations.close();
  });

  it('bounds catalog work across model IDs while allowing shared work and cache hits', async () => {
    const operations = createVoiceOperations();
    const releases: (() => void)[] = [];
    const hook = vi.fn(
      () =>
        new Promise<ProviderOperationResult<ProviderVoiceList>>((resolve) => {
          releases.push(() => resolve(ok(list)));
        }),
    );
    await operations.list('p', 's', 'cached', false, async () => ok(list));
    const pending = Array.from({ length: 4 }, (_, i) =>
      operations.list('p', 's', `m${i}`, false, hook),
    );
    const shared = operations.list('p', 's', 'm0', false, hook);
    expect(
      await operations.list('other', 's', 'm4', false, hook),
    ).toMatchObject({ code: 'rate_limited' });
    expect(await operations.list('p', 's', 'cached', false, hook)).toEqual(
      ok(list),
    );
    expect(
      await operations.list('p', 's', 'm4', false, hook, AbortSignal.abort()),
    ).toMatchObject({ code: 'discovery_failed' });
    await Promise.resolve();
    expect(hook).toHaveBeenCalledTimes(4);
    for (const release of releases) release();
    expect(await Promise.all([...pending, shared])).toEqual(
      Array(5).fill(ok(list)),
    );
    expect(
      await operations.list('p', 's', 'm4', false, async () => ok(list)),
    ).toEqual(ok(list));
    operations.close();
  });

  it('keeps abandoned hooks counted until they settle and never caches their late results', async () => {
    const operations = createVoiceOperations();
    const releases: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const hook = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ProviderOperationResult<ProviderVoiceList>>((resolve) => {
          signals.push(signal);
          releases.push(() => resolve(ok(list)));
        }),
    );
    const pending = Array.from({ length: 4 }, (_, i) =>
      operations.list('p', 's', `m${i}`, false, hook),
    );
    await Promise.resolve();
    operations.invalidate(() => false);
    await Promise.all(pending);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await operations.list('p', 'new', 'm0', false, hook)).toMatchObject({
      code: 'rate_limited',
    });
    for (const release of releases) release();
    const fresh: ProviderVoiceList = { voices: [], defaultVoiceId: 'fresh' };
    const freshHook = vi.fn(async () => ok(fresh));
    await vi.waitFor(async () => {
      expect(await operations.list('p', 's', 'm0', false, freshHook)).toEqual(
        ok(fresh),
      );
    });
    expect(freshHook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(4);
    operations.close();
  });

  it('invalidates dependent preview work and caches without cancelling independent previews', async () => {
    const operations = createVoiceOperations();
    const dependencies = [{ id: 'chat', signature: 'old' }];
    const hook = vi.fn(async () => ok(audio));
    await operations.preview(
      'speech',
      's',
      'm',
      'cached',
      hook,
      undefined,
      'context',
      dependencies,
    );
    let upstream!: AbortSignal;
    let release!: () => void;
    const pending = operations.preview(
      'speech',
      's',
      'm',
      'pending',
      (signal) => {
        upstream = signal;
        return new Promise<ProviderOperationResult<ProviderVoicePreview>>(
          (resolve) => {
            release = () => resolve(ok(audio));
          },
        );
      },
      undefined,
      'context',
      dependencies,
    );
    await operations.preview('speech', 's', 'm', 'independent', hook);
    operations.invalidate(() => true);
    expect(upstream.aborted).toBe(false);
    operations.invalidate(
      (id, signature) => id !== 'chat' || signature === 'new',
    );
    expect(upstream.aborted).toBe(true);
    expect((await pending).ok).toBe(false);
    release();
    await Promise.resolve();
    await operations.preview('speech', 's', 'm', 'independent', hook);
    expect(hook).toHaveBeenCalledTimes(2);
    await operations.preview(
      'speech',
      's',
      'm',
      'cached',
      hook,
      undefined,
      'context',
      [{ id: 'chat', signature: 'new' }],
    );
    expect(hook).toHaveBeenCalledTimes(3);
    operations.close();
  });

  it('cancels one waiter without aborting shared work', async () => {
    const operations = createVoiceOperations();
    let complete!: (value: ProviderOperationResult<ProviderVoiceList>) => void;
    let upstream!: AbortSignal;
    const hook = vi.fn((signal: AbortSignal) => {
      upstream = signal;
      return new Promise<ProviderOperationResult<ProviderVoiceList>>(
        (resolve) => {
          complete = resolve;
        },
      );
    });
    const controller = new AbortController();
    const first = operations.list(
      'p',
      's',
      'm',
      false,
      hook,
      controller.signal,
    );
    const second = operations.list('p', 's', 'm', false, hook);
    await Promise.resolve();
    controller.abort();
    expect((await first).ok).toBe(false);
    expect(upstream.aborted).toBe(false);
    complete(ok(list));
    expect(await second).toEqual(ok(list));
    operations.close();
  });

  it('aborts abandoned or invalidated work and never caches late results', async () => {
    const operations = createVoiceOperations();
    let upstream!: AbortSignal;
    const hook = vi.fn((signal: AbortSignal) => {
      upstream = signal;
      return new Promise<ProviderOperationResult<ProviderVoiceList>>(() => {});
    });
    const pending = operations.list('p', 's', 'm', false, hook);
    await Promise.resolve();
    operations.invalidate(() => false);
    expect((await pending).ok).toBe(false);
    expect(upstream.aborted).toBe(true);
    expect(
      await operations.list('p', 'new', 'm', false, async () => ok(list)),
    ).toEqual(ok(list));
    operations.close();
  });

  it('uses stale discovery only for transient failure, not authentication errors', async () => {
    const operations = createVoiceOperations();
    await operations.list('p', 's', 'm', false, async () => ok(list));
    expect(
      await operations.list('p', 's', 'm', true, async () => ({
        ok: false,
        code: 'discovery_failed',
        message: 'failed',
      })),
    ).toEqual(ok({ ...list, stale: true }));
    expect(
      (
        await operations.list('p', 's', 'm', true, async () => ({
          ok: false,
          code: 'authentication_required',
          message: 'failed',
        }))
      ).ok,
    ).toBe(false);
    operations.close();
  });

  it('limits concurrent uncached previews, but shares identical work', async () => {
    const operations = createVoiceOperations();
    const hook = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ProviderOperationResult<ProviderVoicePreview>>((resolve) =>
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                code: 'preview_failed',
                message: 'cancelled',
              }),
            { once: true },
          ),
        ),
    );
    const a = operations.preview('p', 's', 'm', 'a', hook);
    const shared = operations.preview('p', 's', 'm', 'a', hook);
    const b = operations.preview('p', 's', 'm', 'b', hook);
    expect(await operations.preview('p', 's', 'm', 'c', hook)).toMatchObject({
      code: 'rate_limited',
    });
    await Promise.resolve();
    expect(hook).toHaveBeenCalledTimes(2);
    operations.close();
    await Promise.all([a, b, shared]);
  });

  it('caches preview bytes across selection updates but invalidates credentials', async () => {
    const operations = createVoiceOperations();
    const hook = vi.fn(async () => ok(audio));
    await operations.preview('p', 's', 'm', 'a', hook);
    operations.invalidate((id, signature) => id === 'p' && signature === 's');
    await operations.preview('p', 's', 'm', 'a', hook);
    expect(hook).toHaveBeenCalledTimes(1);
    operations.invalidate(() => false);
    await operations.preview('p', 'new', 'm', 'a', hook);
    expect(hook).toHaveBeenCalledTimes(2);
    operations.close();
  });

  it('separates previews by context while preserving cache hits and provider invalidation', async () => {
    const operations = createVoiceOperations();
    const hook = vi.fn(async () => ok(audio));
    await operations.preview(
      'p',
      's',
      'm',
      'a',
      hook,
      undefined,
      'name-and-soul-v1',
    );
    await operations.preview(
      'p',
      's',
      'm',
      'a',
      hook,
      undefined,
      'name-and-soul-v1',
    );
    await operations.preview(
      'p',
      's',
      'm',
      'a',
      hook,
      undefined,
      'name-and-soul-v2',
    );
    expect(hook).toHaveBeenCalledTimes(2);
    operations.invalidate((id, signature) => id === 'p' && signature === 's');
    await operations.preview(
      'p',
      's',
      'm',
      'a',
      hook,
      undefined,
      'name-and-soul-v2',
    );
    expect(hook).toHaveBeenCalledTimes(2);
    operations.invalidate(() => false);
    await operations.preview(
      'p',
      's',
      'm',
      'a',
      hook,
      undefined,
      'name-and-soul-v2',
    );
    expect(hook).toHaveBeenCalledTimes(3);
    operations.close();
  });

  it('expires discovery, times out silent hooks, and enforces preview quotas', async () => {
    vi.useFakeTimers();
    const operations = createVoiceOperations();
    const hook = vi.fn(async () => ok(list));
    await operations.list('p', 's', 'm', false, hook);
    await vi.advanceTimersByTimeAsync(300_001);
    await operations.list('p', 's', 'm', false, hook);
    expect(hook).toHaveBeenCalledTimes(2);
    const silent = operations.list(
      'p',
      's',
      'silent',
      false,
      () => new Promise(() => {}),
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await silent).ok).toBe(false);
    for (let index = 0; index < 10; index++)
      await operations.preview('p', 's', 'm', String(index), async () =>
        ok(audio),
      );
    expect(
      await operations.preview('p', 's', 'm', 'new', async () => ok(audio)),
    ).toMatchObject({ code: 'rate_limited' });
    expect(
      (await operations.preview('p', 's', 'm', '0', async () => ok(audio))).ok,
    ).toBe(true);
    operations.close();
  });
});
