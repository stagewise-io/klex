type Mount = () => () => void;

export function mountNearViewport(sections: [string, () => Promise<Mount>][]) {
  let disposed = false;
  const cleanup: (() => void)[] = [];
  const pending = new Map<Element, () => Promise<Mount>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const load = pending.get(entry.target);
        if (!load) continue;
        pending.delete(entry.target);
        observer.unobserve(entry.target);
        void load()
          .then((mount) => {
            if (!disposed) cleanup.push(mount());
          })
          .catch((error) =>
            console.error('Could not load website section', error),
          );
      }
    },
    { rootMargin: '600px' },
  );
  for (const [selector, load] of sections) {
    const element = document.querySelector(selector);
    if (!element)
      throw new Error(`The website section ${selector} is missing.`);
    pending.set(element, load);
    observer.observe(element);
  }
  return () => {
    disposed = true;
    observer.disconnect();
    for (const dispose of cleanup.reverse()) dispose();
  };
}
