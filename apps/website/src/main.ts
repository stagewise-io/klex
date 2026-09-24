import './sections.css';
import './style.css';

import { botFamilyMarkup, mountBotFamily } from './bot-family';
import { demoMarkup } from './demo';
import { mountOnboardingStory } from './onboarding-story';
import {
  initializeCapabilityMascots,
  initializeCompanyTabs,
  mountCapabilityNoun,
  sectionsMarkup,
} from './sections';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Klex application root was not found.');
}

const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

darkModeQuery.addEventListener('change', ({ matches }) => {
  document.documentElement.classList.toggle('dark', matches);
});

app.innerHTML = `
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Klex home">
        <img class="klex-logo klex-logo-light" src="/klex-logo-light.svg" alt="Klex" />
        <img class="klex-logo klex-logo-dark" src="/klex-logo-dark.svg" alt="Klex" />
      </a>

      <nav class="site-nav" aria-label="Primary navigation">
        <a href="https://docs.klex.bot">Docs</a>
        <a class="cloud-login" href="https://cloud.klex.bot">Create a Klex Bot</a>
      </nav>
    </header>

    <main id="main">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-intro">
          <p class="meet-klex">Meet Klex Bots</p>
          <h1 id="hero-title">Your own Team of Digital Coworkers</h1>
          <p class="hero-description">Klex Bots are digital co-workers with their own machines and identities - that work with the tools your company already uses.</p>
          <div class="hero-actions"><a class="cloud-login" href="https://cloud.klex.bot">Create a Klex Bot</a></div>
        </div>

        <div class="hero-mascot" id="hero-mascot">
          ${botFamilyMarkup}
        </div>
        ${demoMarkup}
      </section>

      ${sectionsMarkup}

    </main>

    <footer class="site-footer">
      <div class="footer-credit">
        <span>Built with love by</span>
        <a class="stagewise-link" href="https://stagewise.io" target="_blank" rel="noreferrer" aria-label="stagewise">
          <img class="stagewise-wordmark" src="/stagewise-wordmark.svg" alt="stagewise" />
        </a>
      </div>

      <nav class="social-links" aria-label="Social links">
        <a href="https://x.com/stagewise_io" target="_blank" rel="noreferrer">X</a>
        <a href="https://linkedin.com/company/stagewise-io" target="_blank" rel="noreferrer">
          LinkedIn
        </a>
        <a href="https://github.com/stagewise-io/klex" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
    </footer>
    <p class="attribution">Connector marks belong to their respective owners. Illustrative interfaces do not imply endorsement. <a href="/attributions.html">Asset credits</a></p>
  </div>
`;

initializeCompanyTabs();
const cleanupCapabilityMascots = initializeCapabilityMascots();
import.meta.hot?.dispose(cleanupCapabilityMascots);
const disposeCapabilityNoun = mountCapabilityNoun();
import.meta.hot?.dispose(disposeCapabilityNoun);
const disposeStory = mountOnboardingStory();
import.meta.hot?.dispose(disposeStory);

const mascotHost = document.querySelector<HTMLElement>('#hero-mascot');
if (mascotHost) {
  const cleanup = mountBotFamily(mascotHost);
  import.meta.hot?.dispose(cleanup);
}
