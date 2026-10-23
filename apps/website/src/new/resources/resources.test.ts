import { describe, expect, it } from 'vitest';

import brandHtml from '../../../brand/index.html?raw';
import pressHtml from '../../../press/index.html?raw';
import { brandMarkup, pressMarkup } from './resources';

describe('Klex media resources', () => {
  it.each([
    ['brand', brandHtml],
    ['press', pressHtml],
  ])('marks the %s page as noindex in static HTML', (_page, html) => {
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('provides six labeled SVG downloads with fixed theme previews', () => {
    expect(brandMarkup.match(/<a class="resource-download"/g)).toHaveLength(6);
    expect(brandMarkup.match(/download aria-label=/g)).toHaveLength(6);
    for (const source of [
      '/klex-logo-light.svg',
      '/klex-logo-dark.svg',
      '/brand/klex-square-light.svg',
      '/brand/klex-square-dark.svg',
      '/brand/klex-unframed.svg',
      '/brand/klex-avatar.svg',
    ]) {
      expect(brandMarkup).toContain(`src="${source}"`);
      expect(brandMarkup).toContain(`href="${source}" download`);
    }
    expect(brandMarkup).toContain('resource-preview-light');
    expect(brandMarkup).toContain('resource-preview-dark');
  });

  it('offers on-demand PNG exports and four resolution options for every logo', () => {
    expect(brandMarkup.match(/data-png-source=/g)).toHaveLength(6);
    expect(brandMarkup.match(/aria-label="PNG resolution for /g)).toHaveLength(
      6,
    );
    for (const width of [256, 512, 1024, 2048]) {
      expect(
        brandMarkup.match(new RegExp(`value="${width}"`, 'g')),
      ).toHaveLength(6);
    }
    expect(
      brandMarkup.match(/class="resource-download-status" role="status"/g),
    ).toHaveLength(6);
  });

  it('provides a founders photo with a clearly named full-resolution download', () => {
    expect(pressMarkup).toContain(
      'src="/press/stagewise-klex-founders-1600.webp"',
    );
    expect(pressMarkup).toContain('width="3754" height="2816"');
    expect(pressMarkup).toContain(
      'href="/press/stagewise-klex-founders.jpeg" download="stagewise-klex-founders.jpeg"',
    );
    expect(pressMarkup).toContain('Download full resolution');
    expect(pressMarkup).toContain('3754 × 2816 px');
  });
});
