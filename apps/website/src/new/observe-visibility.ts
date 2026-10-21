type Listener = (visible: boolean) => void;
const targets = new Map<
  Element,
  { visible: boolean; listeners: Set<Listener> }
>();
let observer: IntersectionObserver | undefined;

// Moving figures can share a scene viewport; stationary avatars observe themselves.
export function observeVisibility(element: Element, listener: Listener) {
  if (typeof IntersectionObserver === 'undefined') {
    listener(true);
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = targets.get(entry.target);
      if (!target) continue;
      target.visible = entry.isIntersecting;
      for (const notify of target.listeners) notify(target.visible);
    }
  });
  let target = targets.get(element);
  if (!target) {
    target = { visible: false, listeners: new Set() };
    targets.set(element, target);
    observer.observe(element);
  }
  target.listeners.add(listener);
  listener(target.visible);
  return () => {
    target.listeners.delete(listener);
    if (!target.listeners.size) {
      observer?.unobserve(element);
      targets.delete(element);
    }
    if (!targets.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
