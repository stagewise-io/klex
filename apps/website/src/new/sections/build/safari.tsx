import './build.css';

import { type ReactNode, type RefObject, useEffect } from 'react';

// The careers page lays out at this width and zooms out in narrower windows,
// so it keeps its desktop composition instead of reflowing into a cramped one.
const careersPageWidth = 440;

export function useCareersZoom(viewport: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      const zoom = Math.min(1, entry.contentRect.width / careersPageWidth);
      element.style.setProperty('--careers-zoom', String(zoom));
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [viewport]);
}

export function WindowLabel({ title, icon }: { title: string; icon: string }) {
  return (
    <p className="new-window-label">
      <img src={`/connectors/${icon}.svg`} alt="" width="22" height="22" />
      {title}
    </p>
  );
}

export function SafariWindow({
  address,
  label,
  app = 'Browser',
  enter,
  children,
}: {
  address: string;
  label: string;
  app?: 'Browser' | 'GitHub';
  enter?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="new-window-stack" data-window-enter={enter}>
      <WindowLabel title={app} icon={app === 'GitHub' ? 'github' : 'chrome'} />
      <div className="new-safari-window" role="img" aria-label={label}>
        <div className="new-safari-toolbar" aria-hidden="true">
          <span className="new-safari-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="new-safari-arrows">‹ &nbsp; ›</span>
          <span className="new-safari-address">{address}</span>
          <span className="new-safari-reload">↻</span>
        </div>
        <div className="new-safari-viewport">{children}</div>
      </div>
    </div>
  );
}
