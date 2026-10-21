import { useEffect, useRef, useState } from 'react';

type Listener = (playing: boolean, reducedMotion: boolean) => void;
const scenes = new Map<
  Element,
  { visible: boolean; listener: Listener; minimum: number }
>();
let observer: IntersectionObserver | undefined;
let preference: MediaQueryList | undefined;

function update() {
  const reduced = preference?.matches ?? false;
  for (const { visible, listener } of scenes.values()) {
    listener(visible && !document.hidden && !reduced, reduced);
  }
}

export function observePlayback(
  element: Element,
  listener: Listener,
  minimum = 0.15,
) {
  if (!observer) {
    preference = matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const scene = scenes.get(entry.target);
          if (scene)
            scene.visible =
              entry.isIntersecting && entry.intersectionRatio >= scene.minimum;
        }
        update();
      },
      { threshold: [0, 0.15] },
    );
  }
  scenes.set(element, { visible: false, listener, minimum });
  observer.observe(element);
  update();
  return () => {
    observer?.unobserve(element);
    scenes.delete(element);
    if (!scenes.size) {
      observer?.disconnect();
      observer = undefined;
      preference?.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    }
  };
}

export function usePlayback(minimum = 0.15) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ active: false, reducedMotion: false });
  useEffect(() => {
    if (!host.current) return;
    return observePlayback(
      host.current,
      (active, reducedMotion) => {
        setState((previous) =>
          previous.active === active && previous.reducedMotion === reducedMotion
            ? previous
            : { active, reducedMotion },
        );
      },
      minimum,
    );
  }, [minimum]);
  return { host, ...state };
}
