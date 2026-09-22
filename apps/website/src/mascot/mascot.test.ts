import { afterEach, expect, test, vi } from 'vitest';

import { REST_EMOTE } from './emotes';
import { getKlexEyeColor } from './geometry';
import { mascotMarkup, mountMascot } from './index';
import { rig } from './rig';

afterEach(() => vi.unstubAllGlobals());

test('the cloud outline remains finite through breathing and extreme gaze', () => {
  for (let i = 0; i < 60; i++) {
    const result = rig({
      ...REST_EMOTE,
      compression: i / 1000,
      lookX: i,
      nod: Math.sin(i),
    });
    expect(result.path).not.toMatch(/NaN|Infinity/);
    expect(result.path.endsWith(' Z')).toBe(true);
    expect(result.pose.lookX).toBeLessThan(10);
  }
  expect(getKlexEyeColor('#ffbd91')).toBe('#172033');
  expect(getKlexEyeColor('#172033')).toBe('#ffffff');
  const first = mascotMarkup();
  const second = mascotMarkup();
  expect(first).not.toEqual(second); // SVG masks cannot collide across instances.
});

test('one clock respects pause, visibility, reduced motion and disposal', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const preference = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('document', document);
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const attributes = new Map<string, string>();
  const node = {
    setAttribute: (key: string, value: string) => attributes.set(key, value),
  };
  const host = {
    isConnected: true,
    querySelector: () => node,
    querySelectorAll: () => [node, node],
  };
  const mascot = mountMascot(host as unknown as HTMLElement);
  expect(frames.size).toBe(0);
  intersect([{ isIntersecting: true }]);
  expect(frames.size).toBe(1);
  function advance(now: number) {
    const entry = frames.entries().next().value;
    if (!entry) throw new Error('Expected an active frame');
    frames.delete(entry[0]);
    entry[1](now);
  }
  advance(1);
  const restingBody = attributes.get('d');
  advance(17);
  expect(attributes.get('d')).not.toBe(restingBody);
  mascot.hello();
  mascot.hello();
  expect(frames.size).toBe(1);
  for (let frame = 1; frame <= 150; frame++) advance(17 + frame * 16);
  expect(attributes.get('transform')).toBe('translate(0 15)');
  mascot.setPaused(true);
  expect(frames.size).toBe(0);
  mascot.setPaused(false);
  expect(frames.size).toBe(1);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(frames.size).toBe(0);
  document.hidden = false;
  preference.matches = true;
  preference.dispatchEvent(new Event('change'));
  mascot.hello();
  expect(frames.size).toBe(0);
  expect(attributes.get('transform')).toBe('translate(0 0)');
  preference.matches = false;
  preference.dispatchEvent(new Event('change'));
  expect(frames.size).toBe(1);
  intersect([{ isIntersecting: false }]);
  expect(frames.size).toBe(0);
  mascot.dispose();
  mascot.dispose();
  expect(disconnect).toHaveBeenCalledTimes(1);
  mascot.hello();
  mascot.setPaused(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(frames.size).toBe(0);
});
