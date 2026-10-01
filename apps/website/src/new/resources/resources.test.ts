import { describe, expect, it } from 'vitest';

import brandHtml from '../../../brand/index.html?raw';
import pressHtml from '../../../press/index.html?raw';
import avatarSvg from '../../../public/brand/klex-avatar.svg?raw';
import { brandMarkup, pressMarkup } from './resources';

const colorConversions = [
  ['base-50', 'Light Base', '0.992 0.001 85', '253, 252, 252', '#FDFCFC'],
  ['base-900', 'Dark Base', '0.198 0.0005 85', '22, 21, 21', '#161515'],
  ['primary-500', 'Klex Blue', '0.5455 0.25 265', '37, 89, 254', '#2559FE'],
];

describe('Klex media resources', () => {
  it.each([
    ['brand', brandHtml],
    ['press', pressHtml],
  ])('marks the %s page as noindex in static HTML', (_page, html) => {
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('keeps the requested brand section order', () => {
    const positions = ['name', 'description', 'logos', 'colors'].map((id) =>
      brandMarkup.indexOf(`id="${id}"`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('does not include the removed wallpaper generator', () => {
    expect(brandMarkup).not.toContain('wallpaper');
    expect(brandMarkup).not.toContain('<canvas');
    expect(pressMarkup).not.toContain('wallpaper');
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

  it('provides an edge-to-edge avatar with no rounded box corners', () => {
    expect(avatarSvg).toContain('viewBox="0 0 100 100"');
    expect(avatarSvg).toContain(
      '<rect width="100" height="100" fill="#2559FE"',
    );
    expect(avatarSvg.match(/<rect\b[^>]*>/g)).toHaveLength(2);
    expect(avatarSvg).not.toMatch(/<rect\b[^>]*\b(?:rx|ry)=/);
    expect(brandMarkup).toContain('Avatar logo');
  });

  it.each(colorConversions)(
    'documents %s with its color equivalents',
    (...values) => {
      for (const value of values) expect(brandMarkup).toContain(value);
    },
  );

  it('uses direct press headings without the redundant introduction', () => {
    expect(pressMarkup).toContain('<h1>Press Kit</h1>');
    expect(pressMarkup).toContain(
      '<h2 id="press-product-title">About our Bots</h2>',
    );
    expect(pressMarkup).not.toContain('press-summary-title');
    expect(pressMarkup).not.toContain('A short introduction.');
    expect(pressMarkup).toContain(
      'It also makes hosting Klex Bots significantly safer and less compute-intense.',
    );
  });

  it('positions Klex Bots as the next evolution of agents', () => {
    expect(pressMarkup).toContain('We build bots, not agents.');
    expect(pressMarkup).toContain(
      'We see bots as the next evolution of agents',
    );
    expect(pressMarkup).toContain(
      'less constrained by individual tasks or chat sessions',
    );
    expect(pressMarkup).toContain('act autonomously and proactively');
    expect(pressMarkup).toContain('within the permissions its team sets');
    expect(pressMarkup).toContain('hosted bots');
    expect(pressMarkup).not.toContain('Its individual agents');
    expect(pressMarkup).not.toContain('an agent’s durable state');
    expect(pressMarkup).not.toContain('hosted agents');
  });

  it('provides a founders photo with a clearly named full-resolution download', () => {
    expect(pressMarkup).toContain('src="/press/stagewise-klex-founders.jpeg"');
    expect(pressMarkup).toContain('width="3754" height="2816"');
    expect(pressMarkup).toContain(
      'href="/press/stagewise-klex-founders.jpeg" download="stagewise-klex-founders.jpeg"',
    );
    expect(pressMarkup).toContain('Download full resolution');
    expect(pressMarkup).toContain('3754 × 2816 px');
  });

  it('includes naming distinctions and sourced company background', () => {
    expect(brandMarkup).toContain('Klex Bots');
    expect(brandMarkup).toContain('Klex Cloud');
    expect(brandMarkup).toContain('Use lowercase bots');
    expect(brandMarkup).not.toContain('keep the capital B');
    expect(brandMarkup).not.toContain('base-950');
    expect(pressMarkup).toContain('their bots');
    expect(pressMarkup).toContain('href="/brand"');
    expect(pressMarkup).toContain('Glenn Töws');
    expect(pressMarkup).toContain('Julian Götze');
    expect(pressMarkup).toContain('https://company.stagewise.io/company');
    expect(pressMarkup).toContain('Model Context Protocol');
  });
});
