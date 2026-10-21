import { buildMarkup } from './sections/build';
import { coworkersMarkup } from './sections/coworkers';
import { featuresMarkup } from './sections/features';
import { footerMarkup } from './sections/footer';
import { guidesFaqMarkup } from './sections/guides-faq';
import { heroMarkup } from './sections/hero';
import { pullRequestMarkup } from './sections/pull-request';
import { reportMarkup } from './sections/report';
import { slackMarkup } from './sections/slack';
import { trustMarkup } from './sections/trust';
import { workflowMarkup } from './sections/workflow';

export const pageMarkup = `
  <a class="new-skip-link" href="#main">Skip to content</a>
  <header class="new-header">
    <a class="new-brand" href="/" aria-label="Klex home">
      <img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33" />
      <img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33" />
    </a>
    <nav id="new-nav" aria-label="Primary navigation"></nav>
  </header>
  <main id="main">
    ${heroMarkup}
    ${workflowMarkup([
      slackMarkup,
      buildMarkup,
      pullRequestMarkup,
      reportMarkup,
    ])}
    ${coworkersMarkup}
    ${trustMarkup}
    ${guidesFaqMarkup}
    ${featuresMarkup}
  </main>
  ${footerMarkup}
`;
