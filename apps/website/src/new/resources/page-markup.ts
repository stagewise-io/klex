import { footerMarkup } from '../sections/footer';
import { brandMarkup, pressMarkup } from './resources';

export const resourceMarkup = (isPress: boolean) => `
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
