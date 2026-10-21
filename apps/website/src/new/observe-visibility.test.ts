import { afterEach, expect, test, vi } from 'vitest';

import { observeVisibility } from './observe-visibility';

afterEach(() => vi.unstubAllGlobals());

test('shares observations, updates all scene actors and cleans up the last listener', () => {
  let notify: IntersectionObserverCallback = () => {};
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  const created = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
        created();
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const scene = {} as Element;
  const avatar = {} as Element;
  const first = vi.fn();
  const second = vi.fn();
  const third = vi.fn();
  const disposeFirst = observeVisibility(scene, first);
  const disposeThird = observeVisibility(avatar, third);
  const update = (target: Element, isIntersecting: boolean) =>
    notify(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  expect(first).toHaveBeenLastCalledWith(false);
  update(scene, true);
  const disposeSecond = observeVisibility(scene, second);
  expect(second).toHaveBeenLastCalledWith(true);
  expect(third).toHaveBeenLastCalledWith(false);
  expect(created).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledTimes(2);
  update(scene, false);
  expect(first).toHaveBeenLastCalledWith(false);
  expect(second).toHaveBeenLastCalledWith(false);
  disposeFirst();
  expect(unobserve).not.toHaveBeenCalled();
  first.mockClear();
  update(scene, true);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenLastCalledWith(true);
  disposeSecond();
  expect(unobserve).toHaveBeenCalledWith(scene);
  expect(disconnect).not.toHaveBeenCalled();
  disposeThird();
  expect(disconnect).toHaveBeenCalledOnce();
  const disposeNext = observeVisibility(avatar, third);
  expect(created).toHaveBeenCalledTimes(2);
  disposeNext();
});

test('keeps animations available without IntersectionObserver', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const listener = vi.fn();
  const dispose = observeVisibility({} as Element, listener);
  expect(listener).toHaveBeenCalledWith(true);
  dispose();
});
