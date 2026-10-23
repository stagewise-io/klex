import type { ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

/** Hydrates the prerendered `.new-${name}-mount`, or renders it in dev. */
export function mountIsland(name: string, element: ReactNode) {
  const host = document.querySelector(`.new-${name}-mount`);
  if (!host) throw new Error(`The ${name} section is missing.`);
  const options = { identifierPrefix: `${name}-` };
  if (host.hasChildNodes()) {
    const root = hydrateRoot(host, element, options);
    return () => root.unmount();
  }
  const root = createRoot(host, options);
  root.render(element);
  return () => root.unmount();
}
