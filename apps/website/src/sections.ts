import { botIdentities } from './bot-avatar';
import {
  capabilityShapes,
  collaborationShapes,
  hostingCapabilityMascots,
  hostingCollaborationMascots,
} from './capability-mascots';
import { mascotMarkup, mountMascot } from './mascot';

const capabilityBots = ['Harry', 'Momo'] as const;
const capabilityIllustration = (
  name: (typeof capabilityBots)[number],
  hosting = false,
) => {
  const { color, shape } = hosting
    ? hostingCapabilityMascots[name]
    : { color: botIdentities[name].color, shape: capabilityShapes[name] };
  return `<div class="capability-illustration" data-capability-bot="${name}" aria-hidden="true">${mascotMarkup(color, shape)}</div>`;
};

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

const collaborationIllustration =
  () => `<div class="capability-collaboration" aria-hidden="true">
  ${collaborators
    .map(
      ({ name, shape, position }) =>
        `<div class="collaboration-bot collaboration-bot-${position}" data-collaborator="${name}">${mascotMarkup(botIdentities[name].color, shape)}</div>`,
    )
    .join('')}
  <span class="collaboration-chatter"><i></i><i></i><i></i></span>
</div>`;

const containedBot = hostingCollaborationMascots.left;
const cageBars = [58, 76, 93, 111, 129, 147, 164, 182];

// One live bot behind bars: every action has to pass through the cage.
const containmentIllustration =
  () => `<div class="capability-collaboration capability-containment" aria-hidden="true">
  <div class="containment-bot" data-contained-bot>${mascotMarkup(containedBot.color, containedBot.shape)}</div>
  <svg class="containment-cage" viewBox="0 0 240 160" focusable="false">
    <path class="cage-rail" d="M 106 31 Q 120 12 134 31" fill="none" stroke-width="4" stroke-linecap="round" />
    ${cageBars.map((x) => `<path class="cage-bar" d="M ${x} 38 V 145" stroke-width="3" stroke-linecap="round" />`).join('')}
    <rect class="cage-rail-fill" x="50" y="30" width="140" height="9" rx="4.5" />
    <rect class="cage-rail-fill" x="46" y="143" width="148" height="11" rx="5.5" />
    <path class="cage-shackle" d="M 176 98 V 91 a 6 6 0 0 1 12 0 V 98" fill="none" stroke-width="3.5" />
    <rect class="cage-lock" x="171" y="96" width="22" height="19" rx="5" />
    <circle class="cage-keyhole" cx="182" cy="104" r="2.5" />
    <path class="cage-keyhole" d="M 180.8 105 H 183.2 L 184 110 H 180 Z" />
  </svg>
</div>`;

// Activity bots stay live; the conversation poses need no idle clocks.
export function initializeCapabilityMascots() {
  const disposers = Array.from(
    document.querySelectorAll<HTMLElement>('.capabilities'),
    (section) => mountCapabilityMascots(section),
  );
  return () =>
    disposers.forEach((dispose) => {
      dispose();
    });
}

function mountCapabilityMascots(section: HTMLElement) {
  const hosting = section.dataset.capabilityTheme === 'hosting';
  const disposers: (() => void)[] = [];
  const disposeActivities = () =>
    disposers.forEach((dispose) => {
      dispose();
    });
  for (const name of capabilityBots) {
    const host = section.querySelector<HTMLElement>(
      `[data-capability-bot="${name}"]`,
    );
    if (!host) continue;
    const identity = botIdentities[name];
    const mascot = mountMascot(
      host,
      identity.personality,
      hosting ? hostingCapabilityMascots[name].shape : capabilityShapes[name],
    );
    mascot.setActivity(name === 'Harry' ? 'working' : 'note-taking');
    disposers.push(mascot.dispose);
  }

  const contained = section.querySelector<HTMLElement>('[data-contained-bot]');
  if (contained) {
    disposers.push(
      mountMascot(contained, 'curious', containedBot.shape, 3).dispose,
    );
  }

  for (const { name, shape, gaze, expression } of collaborators) {
    const host = section.querySelector<HTMLElement>(
      `[data-collaborator="${name}"]`,
    );
    if (!host) continue;
    const mascot = mountMascot(host, botIdentities[name].personality, shape);
    mascot.setPaused(true);
    mascot.setExpression(expression);
    mascot.lookAt(gaze[0], gaze[1]);
    mascot.dispose();
  }

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

const capabilitiesMarkup = () => `
  <section class="capabilities content-section" aria-label="Klex Bot capabilities">
<article>${capabilityIllustration('Harry')}<h2>Klex Bots get distinct identities in your software stack</h2><p>Every Bot receives a new identity on the tools your company already uses. Jonathan will become @jonathan in Slack, @jonathan-bot on GitHub, and @jonathan in Linear.</p></article>
<article><h2>Klex Bots collaborate and communicate like a team.</h2><p>Klex Bots have their own identities to connect to the tools your company uses. They exchange ideas and work on a Slack thread just like you and your team.</p>${collaborationIllustration()}</article>
<article>${capabilityIllustration('Momo')}<h2>Klex Bots learn <span class="capability-nouns-label">relationships, facts, and processes</span><span class="capability-noun" aria-hidden="true"><span class="capability-noun-size">relationships</span><span class="capability-noun-size">facts</span><span class="capability-noun-size">processes</span><span class="capability-noun-reel"><span>relationships</span><span>facts</span></span></span></h2><p>Klex ships with the best memory implementation by default. It will work and learn out of the box.</p></article>
  </section>
`;

export const sectionsMarkup = `
  <section class="positioning content-section" aria-labelledby="positioning-title">
    <h2 id="positioning-title">Personal AI-Assistants don't work for your business.<br /><span>Klex Bots are Digital Coworkers that do.</span></h2>
  </section>
  ${capabilitiesMarkup()}
  <section class="company-stories content-section" aria-labelledby="companies-title">
    <h2 id="companies-title">Listen to companies that are already bot-native</h2>
    <div class="company-panel">
      <div class="company-media"><img src="/company-stories/stagewise.jpg" alt="Two people working at laptops at a wooden desk beside large office windows" width="1672" height="941" loading="lazy" decoding="async" /></div>
      <div class="company-copy">
<p><strong><em>Kristine</em> is our Product Manager Bot.</strong> She takes bug-reports or feature requests from Slack and E-Mail, checks GitHub issues and <strong>creates structured and scoped Linear issues.</strong> She tells <em>Jonathan</em> what to work on next.</p>
<p><strong><em>Jonathan</em> is our Engineering Bot.</strong> He has his own computer and <strong>uses Codex to create and validate Pull Requests.</strong> He uses <em>Slack</em> and <em>Linear</em> to communicate with other Bots and the rest of the team.</p>
<p><strong><em>Harry</em> is our Head of HR.</strong> He reads every incoming job application with his own <em>Gmail</em> account and makes sure that exceptional talent will not stay unnoticed — and <strong>immediately flags top applications to the Team via <em>Slack</em>.</strong></p>
</div>
</div>
</section>
  <section class="capabilities capabilities-reversed content-section" data-capability-theme="hosting" aria-label="Klex Bot hosting and safety">
<article><h2>Klex Bots are <strong>Open-Source</strong> and can be <strong>self-hosted.</strong></h2><p>If you want to keep your Klex Bot's data, you can self-host it and connect it to the cloud. Read more about it <a href="https://docs.klex.bot">here.</a></p>${capabilityIllustration('Harry', true)}</article>
<article>${containmentIllustration()}<h2>Klex-Bots <strong>are safe to run</strong> on any machine.</h2><p>Klex Bots don't have access to the machines they're running on. Every action they take flow through tools and connectors that you monitor and control.</p></article>
<article><h2>Klex-Bots <strong>won't break</strong> on an update.</h2><p>A Klex Bot doesn't have access to the machine that it's running on. Every potential impact happens via configured tools and connectors.</p>${capabilityIllustration('Momo', true)}</article>
  </section>
  <section class="guides content-section" aria-labelledby="guides-title">
    <h2 id="guides-title">How to operate a Bot-Native Company yourself</h2>
    <ul role="list"><li><a href="https://docs.klex.bot/guides/company-handbook">Create a company-handbook</a></li><li><a href="https://docs.klex.bot/guides/bot-identities">Create distinct identities and permissions for every bot</a></li><li><a href="https://docs.klex.bot/guides/shared-messaging-boards">Use shared messaging boards</a></li></ul>
  </section>
  <section class="faq content-section" aria-labelledby="faq-title">
    <h2 id="faq-title">FAQs</h2>
    <div class="faq-items">
      <details name="faq">
        <summary>What can Klex Bots do?</summary>
        <p>Real work. By connecting the tools that your company uses, Klex Bots perform real tasks and deliver real work just like every other coworker in your company.</p>
      </details>
      <details name="faq">
        <summary>How can I connect the apps my company uses?</summary>
        <p>The Klex Cloud lets you create and connect a new identity for every new Klex Bot per app. That way, a Klex Bot called Jonathan will become @jonathan on your team’s Slack.</p>
      </details>
      <details name="faq">
        <summary>What can they see?</summary>
        <p>They can only see through connectors, so they will only see what you connect and give permissions to.</p>
      </details>
      <details name="faq">
        <summary>Can they handle recurring tasks?</summary>
        <p>Absolutely - ask them to set up a schedule and they will repeatedly start working on the specified task.</p>
      </details>
      <details name="faq">
        <summary>Will they work while I’m away?</summary>
        <p>That’s the whole point. Klex Bots will work while you sleep, attend a conference or hold a meetup.</p>
      </details>
      <details name="faq">
        <summary>Can I use more than one Klex Bot?</summary>
        <p>You <strong>should</strong> use more than one Klex Bot. Every Bot should get a distinct identity and a narrow job. The Bots will collaborate and become a real team.</p>
      </details>
    </div>
  </section>
`;

export function mountCapabilityNoun() {
  const disposers = Array.from(
    document.querySelectorAll<HTMLElement>('.capability-noun'),
    (slot) => mountCapabilityNounSlot(slot),
  );
  return () =>
    disposers.forEach((dispose) => {
      dispose();
    });
}

function mountCapabilityNounSlot(slot: HTMLElement) {
  const reel = slot.querySelector<HTMLElement>('.capability-noun-reel');
  if (!reel) return () => {};

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
