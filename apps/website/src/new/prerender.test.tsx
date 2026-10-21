import { expect, test } from 'vitest';

import { prerenderLandingPage } from './prerender';

test('renders the landing copy and content islands without browser globals', () => {
  const html = prerenderLandingPage();
  expect(html).toContain('Your own team of');
  expect(html).toContain('digital coworkers.');
  expect(html).toContain('What can Klex Bots do?');
  expect(html).toContain('bento-cell');
  for (const section of ['coworkers', 'guides-faq', 'features']) {
    expect(html).not.toContain(`<div class="new-${section}-mount"></div>`);
  }
});
