import { botIdentities } from './bot-avatar';
import { capabilityShapes, collaborationShapes } from './capability-mascots';
import { mascotMarkup, mountMascot } from './mascot';

const capabilityBots = ['Harry', 'Momo'] as const;
const capabilityIllustration = (name: (typeof capabilityBots)[number]) =>
  `<div class="capability-illustration" data-capability-bot="${name}" aria-hidden="true">${mascotMarkup(botIdentities[name].color, capabilityShapes[name])}</div>`;

const collaborators = [
  {
    name: 'Sarah',
    shape: collaborationShapes.listener,
    position: 'top',
    gaze: [0, 9],
    expression: 'happy',
  },
  {
    name: 'Harry',
    shape: collaborationShapes.fin,
    position: 'left',
    gaze: [10, -5],
    expression: 'surprised',
  },
  {
    name: 'Momo',
    shape: collaborationShapes.antenna,
    position: 'right',
    gaze: [-10, -5],
    expression: 'happy',
  },
] as const;

const collaborationIllustration = `<div class="capability-collaboration" aria-hidden="true">
  ${collaborators
    .map(
      ({ name, shape, position }) =>
        `<div class="collaboration-bot collaboration-bot-${position}" data-collaborator="${name}">${mascotMarkup(botIdentities[name].color, shape)}</div>`,
    )
    .join('')}
  <span class="collaboration-chatter"><i></i><i></i><i></i></span>
</div>`;

// Activity bots stay live; the conversation poses need no idle clocks.
export function initializeCapabilityMascots() {
  const disposers: (() => void)[] = [];
  const disposeActivities = () => disposers.forEach((dispose) => dispose());
  for (const name of capabilityBots) {
    const host = document.querySelector<HTMLElement>(
      `[data-capability-bot="${name}"]`,
    );
    if (!host) continue;
    const identity = botIdentities[name];
    const mascot = mountMascot(
      host,
      identity.personality,
      capabilityShapes[name],
    );
    mascot.setActivity(name === 'Harry' ? 'working' : 'note-taking');
    disposers.push(mascot.dispose);
  }

  for (const { name, shape, gaze, expression } of collaborators) {
    const host = document.querySelector<HTMLElement>(
      `[data-collaborator="${name}"]`,
    );
    if (!host) continue;
    const mascot = mountMascot(host, botIdentities[name].personality, shape);
    mascot.setPaused(true);
    mascot.setExpression(expression);
    mascot.lookAt(gaze[0], gaze[1]);
    mascot.dispose();
  }

  const section = document.querySelector<HTMLElement>('.capabilities');
  if (!section) return disposeActivities;
  let visible = false;
  const sync = () => {
    section.toggleAttribute('data-floating', visible && !document.hidden);
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  });
  observer.observe(section);
  document.addEventListener('visibilitychange', sync);
  return () => {
    disposeActivities();
    observer.disconnect();
    document.removeEventListener('visibilitychange', sync);
    section.removeAttribute('data-floating');
  };
}

type CompanyStory = {
  name: string;
  label: string;
  image: { src: string; alt: string; width: number; height: number };
};

const companyStories: CompanyStory[] = [
  {
    name: 'Marcel',
    label: 'Marcel AI-Startup',
    image: {
      src: '/company-stories/marcel.png',
      alt: 'Marcel seated at a laptop in an office',
      width: 1672,
      height: 941,
    },
  },
  {
    name: 'Tobi',
    label: 'Tobi Software-Agency',
    image: {
      src: '/company-stories/tobi.png',
      alt: 'Tobi seated at a laptop beside an office window',
      width: 1672,
      height: 941,
    },
  },
  {
    name: 'Jeff',
    label: 'Jeff Trucking company',
    image: {
      src: '/company-stories/jeff.png',
      alt: 'Jeff at a laptop with dispatch monitors and trucks in the background',
      width: 1672,
      height: 941,
    },
  },
];

export const sectionsMarkup = `
  <section class="positioning content-section" aria-labelledby="positioning-title">
    <h2 id="positioning-title">Personal AI-Assistants don't work for your business.<br /><span>Klex Bots are Digital Coworkers that do.</span></h2>
  </section>
  <section class="capabilities content-section" aria-label="Klex Bot capabilities">
<article>${capabilityIllustration('Harry')}<h2>Klex Bots are Open-Source and can be self-hosted.</h2><p>If you want to keep your Klex Bot's data, you can self-host it and connect it to the cloud. <a href="https://docs.klex.bot">Read more about it here.</a></p></article>
<article><h2>Klex Bots collaborate and communicate like a team.</h2><p>Klex Bots have their own identities to connect to the tools your company uses. They exchange ideas and work on a Slack thread just like you and your team.</p>${collaborationIllustration}</article>
<article>${capabilityIllustration('Momo')}<h2>Klex Bots learn <span class="capability-nouns-label">relationships, facts, and processes</span><span class="capability-noun" aria-hidden="true"><span class="capability-noun-size">relationships</span><span class="capability-noun-size">facts</span><span class="capability-noun-size">processes</span><span class="capability-noun-reel"><span>relationships</span><span>facts</span></span></span></h2><p>Klex ships with the best memory implementation by default. It will work and learn out of the box.</p></article>
  </section>
  <section class="company-stories content-section" aria-labelledby="companies-title">
    <h2 id="companies-title">Listen to companies that are already bot-native:</h2>
    <div class="company-tabs" role="tablist" aria-label="Company stories">${companyStories.map(({ label }, index) => `<button type="button" role="tab" id="company-tab-${index}" aria-controls="company-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</div>
    <div class="company-panel" role="tabpanel" id="company-panel" aria-labelledby="company-tab-0" tabindex="0">
      <div class="company-media"></div>
      <div class="company-copy">
<p>Kristine is our Product Manager Klex Bot. She takes bug-reports from Slack, PostHog, checks GitHub issues and creates Linear issues. She tells Jonathan what to work on next.</p>
<p>Jonathan is our Engineering Bot. He has his own computer-sandbox and uses Codex to work on Linear issues and submit PRs.</p>
<p>Nat is our Quality Engineer. He reviews every Pull Request and makes sure the code diffs are aligned with the coding principles of the company which are written down in the company handbook.</p>
</div>
<p class="company-read-more"><a role="link" aria-disabled="true">Read more to learn about the bot-native structure of CompanyA →</a></p>
</div>
</section>
  <section class="guides content-section" aria-labelledby="guides-title">
    <h2 id="guides-title">Guides on How to Operate a Bot-Native Company:</h2>
    <ul><li>Create a company-handbook</li><li>Create separate identities and permissions for bots</li><li>Use shared messaging boards</li></ul>
  </section>
  <section class="faq content-section" aria-labelledby="faq-title">
    <h2 id="faq-title">FAQ:</h2>
    <div class="faq-items">
      <details>
        <summary>What can a Klex Bot do?</summary>
        <p>Real work. By connecting the tools that your company uses, Klex Bots perform real tasks and deliver real work.</p>
      </details>
      <details>
        <summary>How can I connect the apps of my company?</summary>
        <p>The Klex Cloud lets you create a new identity for every new Klex Bot per app. That way, a Klex Bot called Jonathan will become @jonathan on your team’s Slack.</p>
      </details>
      <details>
        <summary>What can it see?</summary>
        <p>It can only see through connectors, so it will only see what you connect and give permissions to.</p>
      </details>
      <details>
        <summary>Can it handle recurring tasks?</summary>
        <p>Absolutely - ask it to set up a schedule and it will repeatedly start working on the specified task.</p>
      </details>
      <details>
        <summary>Will it work while I’m away?</summary>
        <p>That’s the whole point. Klex Bots will work while you sleep, attend a conference or hold a meetup.</p>
      </details>
      <details>
        <summary>Can I use more than one Klex Bot?</summary>
        <p>You should use more than one Klex Bot. Every Bot should get a distinct identity and a narrow job. The Bots will collaborate and become a real team.</p>
      </details>
    </div>
  </section>
`;

export function mountCapabilityNoun() {
  const slot = document.querySelector<HTMLElement>('.capability-noun');
  const reel = slot?.querySelector<HTMLElement>('.capability-noun-reel');
  if (!slot || !reel) return () => {};

  const nouns = ['relationships', 'facts', 'processes'];
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let index = 0;
  let visible = false;
  let timer = 0;
  let animation: Animation | undefined;
  const render = () => {
    reel.children[0].textContent = nouns[index];
    reel.children[1].textContent = nouns[(index + 1) % nouns.length];
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (!visible || document.hidden || preference.matches) return;
    timer = window.setTimeout(() => {
      animation = reel.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(-50%)' }],
        { duration: 480, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
      animation.onfinish = () => {
        index = (index + 1) % nouns.length;
        render();
        animation = undefined;
        schedule();
      };
    }, 3000);
  };
  const sync = () => {
    animation?.cancel();
    animation = undefined;
    if (preference.matches) index = 0;
    render();
    schedule();
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  });
  observer.observe(slot);
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
      observer.unobserve(slot);
      observer.observe(slot);
    },
    { signal: events.signal },
  );
  return () => {
    events.abort();
    observer.disconnect();
    window.clearTimeout(timer);
    animation?.cancel();
  };
}

export function initializeCompanyTabs() {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.company-tabs [role="tab"]'),
  );
  const media = document.querySelector<HTMLDivElement>('.company-media');
  let activeIndex = -1;
  const select = (index: number) => {
    const story = companyStories[index];
    if (!story || activeIndex === index) return;
    activeIndex = index;
    // The prototype supplies one shared story for the three company tabs.
    document
      .getElementById('company-panel')
      ?.setAttribute('aria-labelledby', `company-tab-${index}`);
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    if (!media) return;

    const image = new Image(story.image.width, story.image.height);
    image.alt = story.image.alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = story.image.src;
    media.replaceChildren(image);
  };
  select(0);
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      select(next);
      tabs[next]?.focus();
    });
  });
}
