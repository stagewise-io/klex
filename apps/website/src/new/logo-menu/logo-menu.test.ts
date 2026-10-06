import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LogoContextMenu, logoMenuActions } from './logo-menu';

describe('Klex logo context menu', () => {
  it.each([false, true])(
    'provides three actions for dark mode = %s',
    (dark) => {
      const theme = dark ? 'dark' : 'light';
      expect(logoMenuActions(dark)).toEqual([
        {
          label: 'Download logo',
          href: `/brand/klex-square-${theme}.svg`,
          download: `klex-square-${theme}.svg`,
        },
        {
          label: 'Download logo + wordmark',
          href: `/klex-logo-${theme}.svg`,
          download: `klex-logo-wordmark-${theme}.svg`,
        },
        { label: 'Show brand kit', href: '/brand', download: undefined },
      ]);
    },
  );

  it('preserves the home link and both theme-specific logo images', () => {
    const markup = renderToStaticMarkup(createElement(LogoContextMenu));
    expect(markup).toContain('href="/"');
    expect(markup).toContain('aria-label="Klex home"');
    expect(markup).toContain('class="new-brand');
    expect(markup).toContain('src="/klex-logo-light.svg"');
    expect(markup).toContain('src="/klex-logo-dark.svg"');
    expect(markup).toContain('data-slot="context-menu-trigger"');
    expect(markup).not.toContain('Download logo');
  });
});
