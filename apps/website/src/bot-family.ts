import { botAvatarMarkup, botIdentities } from './bot-avatar';
import { mountMascot } from './mascot';

const names = ['Harry', 'Sarah', 'Pip', 'Momo'] as const;

export const botFamilyMarkup = `<div class="bot-family" role="group" aria-label="Meet the Klex Bot family">
  ${names
    .map(
      (
        name,
      ) => `<button class="family-bot family-bot-${name.toLowerCase()}" type="button" data-bot="${name}" aria-label="Say hello to ${name}, the ${botIdentities[name].personality} ${botIdentities[name].form === 'classic' ? 'organic' : botIdentities[name].form} Klex Bot">
    <span class="family-avatar" aria-hidden="true">${botAvatarMarkup(name)}</span>
  </button>`,
    )
    .join('')}
</div>`;

export function mountBotFamily(host: HTMLElement) {
  const events = new AbortController();
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const cleanups = names.map((name, index) => {
    const button = host.querySelector<HTMLButtonElement>(
      `[data-bot="${name}"]`,
    );
    const avatar = button?.querySelector<HTMLElement>('.family-avatar');
    if (!button || !avatar) return () => {};
    const identity = botIdentities[name];
    const mascot = mountMascot(
      button,
      identity.personality,
      identity.form,
      41 + index * 137,
      name === 'Harry' ? 'breath' : 'quiet',
    );
    let animation: Animation | undefined;
    let reactionTimer = 0;
    let ambientTimer = 0;
    let visible = false;
    let disposed = false;
    let step = 0;
    const active = () =>
      !disposed && visible && !document.hidden && !preference.matches;
    const engaged = () => button.matches(':hover, :focus-visible');
    const stopReaction = () => {
      window.clearTimeout(reactionTimer);
      delete button.dataset.reacting;
    };
    // Trips return home within reserved space; button/focus targets stay fixed.
    const move = (poses: string[], duration: number) => {
      const from = getComputedStyle(avatar).transform;
      animation?.cancel();
      animation = avatar.animate(
        [
          { transform: from },
          ...poses.map((transform) => ({ transform })),
          { transform: 'none' },
        ],
        { duration, easing: 'ease-in-out' },
      );
    };
    const schedule = () => {
      window.clearTimeout(ambientTimer);
      if (!active()) return;
      // Authored staggered cadence, never an unbounded random walk.
      ambientTimer = window.setTimeout(
        () => {
          if (!active()) return;
          if (!engaged() && !button.dataset.reacting) {
            step++;
            if (name === 'Sarah') mascot.emote('glance', 2.8);
            if (name === 'Pip') mascot.emote('typing', 2.4);
            if (name === 'Momo') {
              // Percentages scale with the fixed slot, including narrow screens.
              move(
                [
                  'translate(-4%, -6%) rotate(-3deg)',
                  'translate(-5%, -5%) rotate(1deg)',
                  'translate(-5%, -5%)',
                ],
                3800,
              );
            }
          }
          schedule();
        },
        6500 + index * 1700 + (step % 3) * 1100,
      );
    };
    const react = () => {
      stopReaction();
      button.dataset.reacting = 'true';
      if (active()) {
        if (name === 'Harry') {
          mascot.emote('hello', 0.8);
          move(['translateY(-5%)', 'translateY(-1%)'], 650);
        } else if (name === 'Sarah') {
          mascot.emote('glance', 0.9);
          move(['rotate(-5deg)', 'rotate(2deg)'], 700);
        } else if (name === 'Pip') {
          mascot.emote('wiggle', 0.8);
          move([], 180);
        } else {
          mascot.emote('hello', 0.9);
          move(['translate(3%, -7%) rotate(5deg)', 'translate(1%, -4%)'], 850);
        }
      } else if (preference.matches) {
        mascot.emote(name === 'Sarah' ? 'glance' : 'hello');
      }
      reactionTimer = window.setTimeout(() => {
        stopReaction();
        if (preference.matches) mascot.reset();
      }, 1000);
      schedule();
    };
    const engage = () => {
      mascot.setEngaged(engaged());
      stopReaction();
      if (active()) {
        move([], 220);
        if (engaged()) {
          if (name === 'Harry') mascot.emote('glance', 0.9);
          if (name === 'Sarah') mascot.emote('wiggle', 0.75);
          if (name === 'Pip') mascot.emote('typing', 0.9);
          if (name === 'Momo') move(['translateY(-3%) rotate(-2deg)'], 700);
        }
      }
      schedule();
    };
    button.addEventListener('pointerenter', engage, { signal: events.signal });
    button.addEventListener('pointerleave', engage, { signal: events.signal });
    button.addEventListener('focus', engage, { signal: events.signal });
    button.addEventListener('blur', engage, { signal: events.signal });
    // Native buttons supply Enter and Space without duplicate key handlers.
    button.addEventListener('click', react, { signal: events.signal });
    const sync = () => {
      animation?.cancel();
      stopReaction();
      mascot.reset();
      mascot.setPaused(!active());
      schedule();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(button);
    preference.addEventListener('change', sync, { signal: events.signal });
    document.addEventListener('visibilitychange', sync, {
      signal: events.signal,
    });
    window.addEventListener(
      'pagehide',
      () => {
        visible = false;
        sync();
      },
      { signal: events.signal },
    );
    window.addEventListener(
      'pageshow',
      () => {
        observer.unobserve(button);
        observer.observe(button);
      },
      { signal: events.signal },
    );
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(ambientTimer);
      animation?.cancel();
      stopReaction();
      mascot.dispose();
    };
  });
  return () => {
    events.abort();
    for (const cleanup of cleanups) cleanup();
  };
}
