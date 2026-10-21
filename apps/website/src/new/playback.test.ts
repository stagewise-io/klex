import { expect, test, vi } from 'vitest';

import { observePlayback } from './playback';

test('combines viewport, tab visibility, and motion preference, including tall grids', () => {
  const page = new EventTarget();
  const preference = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(page, { hidden: false });
  let intersect: (target: Element, ratio: number) => void = () => {};
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      intersect = (target, intersectionRatio) =>
        callback(
          [
            {
              target,
              intersectionRatio,
              isIntersecting: intersectionRatio > 0,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('document', document);
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('IntersectionObserver', Observer);
  const grid = {} as Element;
  const scene = {} as Element;
  const onGrid = vi.fn();
  const onScene = vi.fn();
  const stopGrid = observePlayback(grid, onGrid, 0);
  const stopScene = observePlayback(scene, onScene);
  try {
    intersect(grid, 0.05);
    intersect(scene, 0.05);
    expect(onGrid).toHaveBeenLastCalledWith(true, false);
    expect(onScene).toHaveBeenLastCalledWith(false, false);
    intersect(scene, 0.5);
    expect(onScene).toHaveBeenLastCalledWith(true, false);
    document.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(onGrid).toHaveBeenLastCalledWith(false, false);
    document.hidden = false;
    preference.matches = true;
    preference.dispatchEvent(new Event('change'));
    expect(onScene).toHaveBeenLastCalledWith(false, true);
    preference.matches = false;
    preference.dispatchEvent(new Event('change'));
    expect(onScene).toHaveBeenLastCalledWith(true, false);
  } finally {
    stopGrid();
    stopScene();
    vi.unstubAllGlobals();
  }
});
