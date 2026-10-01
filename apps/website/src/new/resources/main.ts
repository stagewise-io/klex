import '../base.css';
import '../navigation.css';

import { mountLogoMenus } from '../logo-menu';
import { mountNavigation } from '../navigation';
import { footerMarkup } from '../sections/footer';
import { mountPngDownloads } from './png-downloads';
import { brandMarkup, pressMarkup } from './resources';

const app = document.getElementById('app');
if (!app) throw new Error('The website root is missing.');

const isPress = location.pathname.replace(/\/$/, '') === '/press';
document.body.classList.add('resource-page');
app.innerHTML = `
  <a class="new-skip-link" href="#main">Skip to content</a>
  <header class="new-header">
    <a class="new-brand" href="/" aria-label="Klex home">
      <img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33" />
      <img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33" />
    </a>
    <nav id="new-nav" aria-label="Primary navigation"></nav>
  </header>
  <main id="main" class="resource-main">
    ${isPress ? pressMarkup : brandMarkup}
  </main>
  ${footerMarkup}
`;

const events = new AbortController();
matchMedia('(prefers-color-scheme: dark)').addEventListener(
  'change',
  ({ matches }) => document.documentElement.classList.toggle('dark', matches),
  { signal: events.signal },
);
const disposeLogoMenus = mountLogoMenus(app);
const disposeNavigation = mountNavigation();
const disposePngDownloads = mountPngDownloads(app);
import.meta.hot?.dispose(() => {
  events.abort();
  disposeLogoMenus();
  disposeNavigation();
  disposePngDownloads();
});
