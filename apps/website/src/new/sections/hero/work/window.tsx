import { motion } from 'motion/react';
import { type ReactNode, useEffectEvent, useLayoutEffect, useRef } from 'react';

import { popTransition } from '../../../klex/transitions';
import { WindowLabel } from '../../build/safari';

/** Work scenes are drawn at this size and scaled down to fit the window. */
const designWidth = 440;
const designHeight = 290;

export type WorkApp = {
  name: string;
  icon: string;
};

const gutter = 16;
const gap = 12;
const foregroundOverlap = 12;
const minimumScale = 0.6;

/** A readable app preview on the floor behind its working bot. */
export function WorkWindow({
  bot,
  app,
  children,
}: {
  /** The bot's layer in the hero team. */
  bot: () => HTMLElement | null | undefined;
  app: WorkApp;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const findBot = useEffectEvent(bot);

  useLayoutEffect(() => {
    const element = frame.current;
    const layer = element?.offsetParent;
    if (!element || !layer) return;
    const copy = layer
      .closest('.new-hero')
      ?.querySelectorAll('h1, .new-description, .new-hero-cta');
    const label = element.querySelector<HTMLElement>('.new-window-label');
    const place = () => {
      const figure = findBot()?.querySelector('[data-klex-figure]');
      if (!figure) return;
      // Use the visible body, not its ground track: flying bots sit higher.
      const box = (
        figure.querySelector('[data-testid="klex-body"]') ?? figure
      ).getBoundingClientRect();
      const bounds = layer.getBoundingClientRect();
      const center = box.left + box.width / 2 - bounds.left;
      const mobile = bounds.width < 650;
      const preferredWidth = Math.min(
        mobile ? 300 : 360,
        bounds.width - gutter * 2,
      );
      const labelHeight = (label?.offsetHeight ?? 0) + 10;
      const preferredLeft = Math.min(
        Math.max(center - preferredWidth / 2, gutter),
        bounds.width - gutter - preferredWidth,
      );
      // The preview can overlap the team, but never the headline or CTA.
      const copyBottom = Math.max(
        0,
        ...Array.from(copy ?? [], (item) => {
          const rect = item.getBoundingClientRect();
          return rect.right > bounds.left + preferredLeft &&
            rect.left < bounds.left + preferredLeft + preferredWidth
            ? rect.bottom - bounds.top
            : 0;
        }),
      );
      // The bot straddles the lower edge; only its feet extend below it.
      const bottom = Math.min(
        box.bottom - bounds.top - foregroundOverlap,
        bounds.height - gutter,
      );
      const availableHeight = bottom - copyBottom - gap - labelHeight;
      const width = Math.min(
        Math.max(0, availableHeight) * (designWidth / designHeight),
        preferredWidth,
      );
      const scale = width / designWidth;
      const left = Math.min(
        Math.max(center - width / 2, gutter),
        bounds.width - gutter - width,
      );
      const height = (width * designHeight) / designWidth + labelHeight;
      const top = bottom - height;
      // A bot sent up close to the copy has no room for a readable preview.
      // Skip the window then instead of shrinking it to a thumbnail.
      element.style.visibility =
        width >= preferredWidth * minimumScale ? 'visible' : 'hidden';
      element.style.setProperty('--work-width', `${width}px`);
      element.style.setProperty('--work-scale', String(scale));
      element.style.setProperty(
        '--work-origin',
        `${Math.min(Math.max(center - left, gap), width - gap)}px ${Math.min(Math.max(box.top + box.height / 2 - bounds.top - top, gap), height - gap)}px`,
      );
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    // Place once and again after layout changes. Following the body every
    // frame made the window shake while the bot types or breathes.
    place();
    let pending = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      // Let the team snap to its resized spots before measuring.
      pending = requestAnimationFrame(place);
    });
    resize.observe(layer);
    return () => {
      resize.disconnect();
      cancelAnimationFrame(pending);
    };
  }, []);

  return (
    <div ref={frame} className="new-work" aria-hidden="true">
      <motion.div
        className="new-work-window"
        // Reveals from behind the bot and shrinks back into it when done.
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        exit={{
          scale: 0,
          transition: { duration: 0.16, ease: [0.5, 0, 1, 0.5] },
        }}
        transition={popTransition}
      >
        <WindowLabel title={app.name} icon={app.icon} />
        <div className="new-work-viewport">
          <div className="new-work-scene">{children}</div>
        </div>
      </motion.div>
    </div>
  );
}
