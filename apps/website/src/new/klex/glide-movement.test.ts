import { afterEach, expect, test, vi } from 'vitest';

import { createGlide } from './glide';
import { MOVEMENT_STYLES } from './presets';

const { ticks, transforms } = vi.hoisted(() => ({
  ticks: new Set<(time: number, delta: number) => void>(),
  transforms: new WeakMap<object, Record<string, number>>(),
}));

vi.mock('gsap', async (importOriginal) => {
  const { gsap } = await importOriginal<typeof import('gsap')>();
  return {
    gsap: {
      ...gsap,
      set: vi.fn(),
      quickSetter: (element: object, property: string) => (value: number) => {
        const values = transforms.get(element) ?? {};
        values[property] = value;
        transforms.set(element, values);
      },
      ticker: {
        add: (tick: (time: number, delta: number) => void) => ticks.add(tick),
        remove: (tick: (time: number, delta: number) => void) =>
          ticks.delete(tick),
      },
    },
  };
});

afterEach(() => ticks.clear());

function element<T extends Element>() {
  const attributes = new Map<string, string>();
  return {
    clientWidth: 1200,
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    querySelector: () => null,
  } as unknown as T;
}

test.each(['crawl', 'hop', 'fly'] as const)(
  '%s keeps its animation and completion timing when the layout shifts',
  (mode) => {
    const settings = MOVEMENT_STYLES.find(
      (entry) => entry.id === mode,
    )!.settings;
    const makeBot = () => {
      const elements = {
        travel: element<HTMLDivElement>(),
        actor: element<HTMLDivElement>(),
        shadow: element<SVGEllipseElement>(),
        body: element<SVGPathElement>(),
        eyes: element<SVGGElement>(),
        laptop: element<SVGGElement>(),
      };
      const complete = vi.fn();
      const arrive = vi.fn();
      const glide = createGlide(
        elements,
        complete,
        undefined,
        undefined,
        settings,
        { x: -20, y: -140 },
        undefined,
        arrive,
      );
      glide.moveTo({ x: -20, y: -340 });
      return { elements, glide, complete, arrive };
    };
    const original = makeBot();
    const resized = makeBot();
    let offset = { x: 0, y: 0 };
    for (let frame = 0; frame < 900; frame++) {
      for (const tick of ticks) tick(frame / 60, 1000 / 60);
      // Resize during travel, including the airborne part of the first hop.
      if (frame === 30 || frame === 50) {
        if (frame === 30 && mode === 'hop')
          expect(transforms.get(resized.elements.actor)!.y).toBeLessThan(-1);
        const shift = frame === 30 ? { x: 12, y: 65 } : { x: -6, y: -110 };
        resized.glide.shiftBy(shift);
        offset = { x: offset.x + shift.x, y: offset.y + shift.y };
      }
      const before = transforms.get(original.elements.travel)!;
      const after = transforms.get(resized.elements.travel)!;
      expect(after.xPercent).toBeCloseTo(before.xPercent + offset.x, 8);
      expect(after.y).toBeCloseTo(before.y + offset.y, 8);
      expect(transforms.get(resized.elements.actor)!.y).toBeCloseTo(
        transforms.get(original.elements.actor)!.y,
        8,
      );
      expect(resized.arrive.mock.calls.length).toBe(
        original.arrive.mock.calls.length,
      );
      expect(resized.complete.mock.calls.length).toBe(
        original.complete.mock.calls.length,
      );
    }
    expect(resized.arrive).toHaveBeenCalledOnce();
    expect(resized.complete).toHaveBeenCalledOnce();
    expect(transforms.get(resized.elements.travel)!.y).toBeCloseTo(
      -340 + offset.y,
    );
    original.glide.dispose();
    resized.glide.dispose();
  },
);

test.each([false, true])(
  'flying characters stay airborne after repositioning (reduced motion: %s)',
  (reduced) => {
    const settings = MOVEMENT_STYLES.find(
      (entry) => entry.id === 'fly',
    )!.settings;
    const elements = {
      travel: element<HTMLDivElement>(),
      actor: element<HTMLDivElement>(),
      shadow: element<SVGEllipseElement>(),
      body: element<SVGPathElement>(),
      eyes: element<SVGGElement>(),
      laptop: element<SVGGElement>(),
    };
    const glide = createGlide(
      elements,
      vi.fn(),
      undefined,
      undefined,
      settings,
    );
    glide.configure(settings, reduced);
    glide.snapTo({ x: 12, y: -200 });
    expect(transforms.get(elements.actor)!.y).toBe(-64);
    glide.shiftBy({ x: 2, y: 10 });
    expect(transforms.get(elements.actor)!.y).toBe(-64);
    glide.moveTo({ x: 14, y: -230 });
    for (let frame = 0; frame < 600; frame++) {
      for (const tick of ticks) tick(frame / 60, 1000 / 60);
      expect(transforms.get(elements.actor)!.y).toBeLessThan(-50);
      expect(Number(elements.shadow.getAttribute('opacity'))).toBeGreaterThan(
        0.35,
      );
    }
    glide.pause(true);
    glide.snapTo({ x: -10, y: -100 });
    expect(transforms.get(elements.actor)!.y).toBe(-64);
    glide.dispose();
  },
);
