import { headerMarkup } from './navigation';
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

export const pageMarkup = `${headerMarkup}  <main id="main">
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
