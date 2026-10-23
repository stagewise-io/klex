import { renderToString } from 'react-dom/server';

import { pageMarkup } from './page-markup';
import { Coworkers } from './sections/coworkers';
import { FeatureBento } from './sections/features/bento';
import { GuidesFaq } from './sections/guides-faq';

// Each island hydrates through mountIsland with the same name.
const islands = {
  coworkers: <Coworkers />,
  'guides-faq': <GuidesFaq />,
  features: <FeatureBento />,
};

export function prerenderLandingPage() {
  return Object.entries(islands).reduce(
    (html, [name, element]) =>
      html.replace(
        `<div class="new-${name}-mount"></div>`,
        `<div class="new-${name}-mount">${renderToString(element, { identifierPrefix: `${name}-` })}</div>`,
      ),
    pageMarkup,
  );
}
