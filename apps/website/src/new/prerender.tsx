import { renderToString } from 'react-dom/server';

import { pageMarkup } from './page-markup';
import { Coworkers } from './sections/coworkers';
import { FeatureBento } from './sections/features/bento';
import { GuidesFaq } from './sections/guides-faq';

export function prerenderLandingPage() {
  return pageMarkup
    .replace(
      '<div class="new-coworkers-mount"></div>',
      `<div class="new-coworkers-mount">${renderToString(<Coworkers />, { identifierPrefix: 'coworkers-' })}</div>`,
    )
    .replace(
      '<div class="new-guides-faq-mount"></div>',
      `<div class="new-guides-faq-mount">${renderToString(<GuidesFaq />, { identifierPrefix: 'guides-faq-' })}</div>`,
    )
    .replace(
      '<div class="new-features-mount"></div>',
      `<div class="new-features-mount">${renderToString(<FeatureBento />, { identifierPrefix: 'features-' })}</div>`,
    );
}
