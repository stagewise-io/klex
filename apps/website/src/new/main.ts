import './base.css';
import './navigation.css';

import { mountNavigation } from './navigation';
import { buildMarkup, mountBuild } from './sections/build';
import { coworkersMarkup, mountCoworkers } from './sections/coworkers';
import { featuresMarkup, mountFeatures } from './sections/features';
import { footerMarkup } from './sections/footer';
import { guidesFaqMarkup, mountGuidesFaq } from './sections/guides-faq';
import { heroMarkup, mountHero } from './sections/hero';
import { mountPullRequest, pullRequestMarkup } from './sections/pull-request';
import { mountReport, reportMarkup } from './sections/report';
import { mountSlack, slackMarkup } from './sections/slack';
import { mountTrust, trustMarkup } from './sections/trust';
import { mountWorkflow, workflowMarkup } from './sections/workflow';

const app = document.getElementById('app');
if (!app) throw new Error('The website root is missing.');

app.innerHTML = `
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

const events = new AbortController();
const theme = matchMedia('(prefers-color-scheme: dark)');
theme.addEventListener(
  'change',
  ({ matches }) => document.documentElement.classList.toggle('dark', matches),
  { signal: events.signal },
);

const disposers = [
  mountNavigation(),
  mountHero(),
  mountSlack(),
  mountBuild(),
  mountPullRequest(),
  mountReport(),
  mountWorkflow(),
  mountCoworkers(),
  mountTrust(),
  mountGuidesFaq(),
  mountFeatures(),
];

import.meta.hot?.dispose(() => {
  events.abort();
  for (const dispose of disposers) dispose();
});
