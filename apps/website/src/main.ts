import './sections.css';
import './style.css';

import { botFamilyMarkup, mountBotFamily } from './bot-family';
import { demoMarkup } from './demo';
import { mountOnboardingStory } from './onboarding-story';
import {
  initializeCapabilityMascots,
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
        <a class="github-link" href="https://github.com/stagewise-io/klex" target="_blank" rel="noreferrer" aria-label="Klex on GitHub">
          <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        </a>
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
