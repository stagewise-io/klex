import './hero.css';

import { scroll } from 'motion';

import { buttonVariants } from '@stagewise/ui/src/components/ui/button.tsx';

import { playHeroIntro } from './intro';
import { mountHeroTeam } from './team';

export const heroMarkup = `
      <section class="new-hero" aria-labelledby="new-hero-title">
        <p class="new-eyebrow"><span class="new-eyebrow-word">Meet</span> <span class="new-eyebrow-word">Klex Bots</span></p>
        <h1 id="new-hero-title">Your own team of<br />digital coworkers.</h1>
        <p class="new-description">Klex Bots work with their own identities and machines in the tools your team already uses. 24/7, 365 days a year.</p>
        <a class="new-hero-cta ${buttonVariants({ size: 'lg' })}" data-slot="button" href="https://cloud.klex.bot">Create a Klex Bot</a>
        <div class="new-hero-mount"></div>
        <a class="new-hero-next ${buttonVariants({ variant: 'outline', size: 'lg' })}" data-slot="button" href="#how-it-works">How Klex Bots work together <span aria-hidden="true">↓</span></a>
      </section>
`;

export function mountHero() {
  const hero = document.querySelector<HTMLElement>('.new-hero');
  const host = document.querySelector<HTMLDivElement>('.new-hero-mount');
  const next = hero?.querySelector<HTMLAnchorElement>('.new-hero-next');
  if (!hero || !host || !next)
    throw new Error('The hero container is missing.');

  let startTeam = () => {};
  const entrance = new Promise<void>((resolve) => {
    startTeam = resolve;
  });
  const disposeTeam = mountHeroTeam(host, entrance);
  const disposeIntro = playHeroIntro(hero, startTeam);
  const disposeScroll = scroll(
    (progress: number) => {
      next.style.setProperty('--hero-next-opacity', String(1 - progress));
      next.inert = progress === 1;
    },
    { target: hero, offset: ['end 85%', 'end 77%'] },
  );
  return () => {
    disposeScroll();
    disposeIntro();
    disposeTeam();
  };
}
