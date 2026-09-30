import { gsap } from 'gsap';

const stages = ['has-copy', 'has-ground'] as const;

/**
 * Plays the opening sequence: "Meet Klex Bots" rises in word by word while
 * the ground reveals, the headline follows shortly after, then the team
 * walks in. Each step after the eyebrow adds a class to the hero.
 */
export function playHeroIntro(hero: HTMLElement, startTeam: () => void) {
  let timeline: gsap.core.Timeline | undefined;
  let finished = false;

  const stop = () => {
    finished = true;
    timeline?.kill();
  };
  const finish = () => {
    if (finished) return;
    stop();
    hero.classList.add(...stages);
    startTeam();
  };

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || hero.getBoundingClientRect().bottom <= 0) {
    finish();
    return stop;
  }

  const eyebrow = hero.querySelector<HTMLElement>('.new-eyebrow');
  const [meet, name] = hero.querySelectorAll<HTMLElement>('.new-eyebrow-word');
  if (!eyebrow || !meet || !name)
    throw new Error('The hero eyebrow is missing.');
  // Shift the eyebrow so "Meet" starts alone in the middle. Measured when the
  // intro starts, once the page's styles and fonts have been applied.
  const meetCentered = () =>
    eyebrow.offsetWidth / 2 - (meet.offsetLeft + meet.offsetWidth / 2);

  timeline = gsap
    .timeline({ delay: 0.08, onComplete: finish })
    // "Meet" rises in centered, then the line slides left to make room, and
    // only once it is moving does "Klex Bots" rise in next to it.
    .fromTo(
      meet,
      { opacity: 0, yPercent: 45 },
      { opacity: 1, yPercent: 0, duration: 0.34, ease: 'power3.out' },
      0,
    )
    .set(eyebrow, { x: meetCentered }, 0)
    .to(eyebrow, { x: 0, duration: 0.42, ease: 'power3.inOut' }, 0.18)
    .fromTo(
      name,
      { opacity: 0, yPercent: 45 },
      { opacity: 1, yPercent: 0, duration: 0.34, ease: 'power3.out' },
      0.28,
    )
    .call(() => hero.classList.add('has-ground'), undefined, 0)
    .call(() => hero.classList.add('has-copy'), undefined, 0.12);
  // The team starts when the timeline completes, while the camera is still
  // rising and flying in, so the bots pop onto a floor that is still settling.

  return stop;
}
