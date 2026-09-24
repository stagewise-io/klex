import { afterEach, expect, test, vi } from 'vitest';

import { createActivity } from './activity';
import { emotePose, REST_EMOTE } from './emotes';
import { getKlexEyeColor } from './geometry';
import { createGlide } from './glide';
import { createIdle } from './idle';
import { mascotMarkup, mountMascot } from './index';
import { FAMILY_SHAPES } from './presets';
import { rig } from './rig';

afterEach(() => vi.unstubAllGlobals());

test('family gestures settle and stay within the existing face rig', () => {
  for (const kind of ['glance', 'typing', 'wiggle'] as const) {
    expect(emotePose(kind, 1)).toEqual(REST_EMOTE);
    for (const shape of Object.values(FAMILY_SHAPES)) {
      for (let i = 0; i <= 100; i++) {
        const state = rig(emotePose(kind, i / 100), shape);
        expect(state.path + state.face).not.toMatch(/NaN|Infinity/);
        expect(Math.abs(state.pose.lookX)).toBeLessThan(8);
        expect(Math.abs(state.pose.headTilt)).toBeLessThanOrEqual(6);
      }
    }
  }
});

test('distinct forms keep their eyes contained through all idle poses', () => {
  const paths = new Set<string>();
  for (const shape of Object.values(FAMILY_SHAPES)) {
    paths.add(rig(REST_EMOTE, shape).path);
    const idle = createIdle(41);
    for (let i = 0; i < 2400; i++) {
      idle.advance(0.05, true);
      const state = rig(idle.pose(1), shape);
      expect(state.path + state.face).not.toMatch(/NaN|Infinity/);
      expect(Math.abs(state.pose.lookX)).toBeLessThan(8);
    }
  }
  expect(paths.size).toBe(4);
});

test('idle is repeatable per seed and independent between bots', () => {
  const first = createIdle(41);
  const repeat = createIdle(41);
  const sibling = createIdle(178);
  for (let i = 0; i < 500; i++) {
    for (const idle of [first, repeat, sibling]) idle.advance(0.05, true);
    expect(first.pose(1)).toEqual(repeat.pose(1));
  }
  expect(first.pose(1)).not.toEqual(sibling.pose(1));
});

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
  const node = (selector: string) => ({
    setAttribute: (key: string, value: string) =>
      attributes.set(`${selector}:${key}`, value),
  });
  const host = {
    isConnected: true,
    querySelector: (selector: string) => node(selector),
    querySelectorAll: (selector: string) => [node(selector), node(selector)],
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
  const restingBody = attributes.get('[data-body]:d');
  advance(17);
  expect(attributes.get('[data-body]:d')).not.toBe(restingBody);
  mascot.hello();
  mascot.hello();
  expect(frames.size).toBe(1);
  for (let frame = 1; frame <= 150; frame++) advance(17 + frame * 16);
  expect(attributes.get('[data-happy]:transform')).toBe('translate(0 15)');
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
  expect(attributes.get('[data-happy]:transform')).toBe('translate(0 0)');
  mascot.setActivity('working');
  expect(attributes.get('[data-laptop]:opacity')).toBe('1');
  mascot.setActivity('note-taking');
  expect(attributes.get('[data-laptop]:opacity')).toBe('0');
  expect(attributes.get('[data-note]:opacity')).toBe('1');
  expect(attributes.get('[data-pencil]:transform')).toBe(
    'translate(0 0) rotate(0 12 26)',
  );
  mascot.moveTo('right', 'fly');
  expect(attributes.get('[data-travel]:transform')).toBe('translate(8 0)');
  expect(frames.size).toBe(0);
  mascot.setActivity('sleeping');
  expect(attributes.get('[data-laptop]:opacity')).toBe('0');
  expect(attributes.get('[data-closed]:opacity')).toBe('1');
  mascot.reset();
  expect(attributes.get('[data-note]:opacity')).toBe('0');
  preference.matches = false;
  preference.dispatchEvent(new Event('change'));
  expect(frames.size).toBe(1);
  mascot.setActivity('note-taking');
  let now = 3000;
  const run = (count: number) => {
    for (let i = 0; i < count; i++) advance((now += 16));
  };
  run(100);
  expect(Number(attributes.get('[data-note]:opacity'))).toBeGreaterThan(0.99);
  mascot.emote('nod', 2);
  run(50);
  expect(Number(attributes.get('[data-note]:opacity'))).toBeLessThan(0.01);
  run(150);
  expect(Number(attributes.get('[data-note]:opacity'))).toBeGreaterThan(0.99);
  mascot.moveTo('left', 'crawl');
  run(30);
  expect(Number(attributes.get('[data-note]:opacity'))).toBeLessThan(0.01);
  run(300);
  expect(Number(attributes.get('[data-note]:opacity'))).toBeGreaterThan(0.99);
  mascot.setPaused(true);
  expect(frames.size).toBe(0);
  mascot.setPaused(false);
  intersect([{ isIntersecting: false }]);
  expect(frames.size).toBe(0);
  mascot.dispose();
  mascot.dispose();
  expect(disconnect).toHaveBeenCalledTimes(1);
  mascot.hello();
  mascot.setPaused(false);
  const disposedAttributes = new Map(attributes);
  mascot.setActivity('working');
  mascot.setActivity('note-taking');
  mascot.setExpression('surprised');
  mascot.lookAt(10, 10);
  mascot.moveTo('left');
  mascot.reset();
  expect(attributes).toEqual(disposedAttributes);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(frames.size).toBe(0);
});

test('note-taking strokes vary, pause with interruptions and have a static pose', () => {
  const motion = createActivity(4);
  const repeat = createActivity(4);
  const strokes = new Set<number>();
  for (let i = 0; i < 1200; i++) {
    motion.advance(0.05, 'note-taking');
    repeat.advance(0.05, 'note-taking');
    expect(motion.writing).toBe(repeat.writing);
    expect(motion.writing).toBeGreaterThanOrEqual(0);
    expect(motion.writing).toBeLessThanOrEqual(1);
    strokes.add(motion.writing);
  }
  expect(strokes.size).toBeGreaterThan(100);
  const pose = motion.pose('note-taking');
  const stroke = motion.writing;
  motion.advance(1, 'idle');
  expect(motion.pose('note-taking')).toEqual(pose);
  expect(motion.writing).toBe(stroke);
  expect(motion.pose('note-taking', true)).toEqual(
    motion.pose('working', true),
  );
});

test('travel stays bounded through reversals, frame gaps and reduced motion', () => {
  const glide = createGlide();
  for (const mode of ['crawl', 'fly', 'hop'] as const) {
    glide.moveTo(999, mode);
    for (let i = 0; i < 600; i++) {
      if (i === 200) glide.moveTo('left');
      glide.advance(i % 7 === 0 ? 0.5 : 1 / 60);
      const [x = NaN, y = NaN] = glide.transform
        .slice(10, -1)
        .split(' ')
        .map(Number);
      expect(Math.abs(x)).toBeLessThanOrEqual(8);
      expect(y).toBeGreaterThanOrEqual(-7);
      expect(y).toBeLessThanOrEqual(0);
    }
    glide.advance(0, true);
    expect(glide.transform).toBe('translate(-8 0)');
    expect(glide.moving).toBe(false);
    glide.moveTo(Number.NaN);
    glide.advance(0, true);
    expect(glide.transform).toBe('translate(-8 0)');
  }
});

test('working phases are seeded, varied, finite and retain a static alternative', () => {
  const first = createActivity(4);
  const second = createActivity(4);
  const poses = new Set<string>();
  for (let i = 0; i < 1200; i++) {
    first.advance(0.05, 'working');
    second.advance(0.05, 'working');
    expect(first.pose('working')).toEqual(second.pose('working'));
    for (const shape of Object.values(FAMILY_SHAPES)) {
      expect(rig(first.pose('working'), shape).path).not.toMatch(
        /NaN|Infinity/,
      );
    }
    poses.add(JSON.stringify(first.pose('working')));
  }
  expect(poses.size).toBeGreaterThan(100);
  expect(first.pose('working', true)).toEqual({
    ...REST_EMOTE,
    compression: 0.025,
    nod: 0.15,
    lookY: 2,
  });
  expect(first.pose('sleeping', true).blinkLeft).toBe(1);
});

test('custom shapes use the same markup and rig without altering family presets', () => {
  const shape = { ...FAMILY_SHAPES.box, eyeX: 3, eyeY: 62 };
  expect(mascotMarkup('#ffbd91', shape)).toContain(rig(REST_EMOTE, shape).path);
  for (const kind of [
    'wink',
    'look-left',
    'look-up',
    'look-down',
    'nod',
    'headshake',
  ] as const) {
    expect(emotePose(kind, 1)).toEqual(REST_EMOTE);
    expect(rig(emotePose(kind, 0.5), shape).face).not.toMatch(/NaN|Infinity/);
  }
});
