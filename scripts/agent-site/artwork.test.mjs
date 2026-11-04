import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { createStaticArtwork } from './artwork.mjs';

it('externalizes static geometry while preserving layering, inherited theme styles, and portal hosts', () => {
  const geometry = `<polygon class="office-paper" points="${'1,2 '.repeat(300)}" />`;
  const html = `<svg class="office-drawing">${geometry}<g data-office-bot="kristine"></g>${geometry}</svg>`;
  const result = createStaticArtwork().extract(
    html,
    '.office-human-figure { stroke: var(--office-line); }.office-drawing polygon { fill: var(--office-paper); }@media (max-width:700px) {}',
  );
  expect(result.assets).toHaveLength(1);
  expect(result.html).not.toContain('<polygon');
  expect(result.html).toContain('data-office-bot="kristine"');
  expect(result.html.indexOf('#geometry-0')).toBeLessThan(
    result.html.indexOf('data-office-bot'),
  );
  expect(result.html.indexOf('#geometry-1')).toBeGreaterThan(
    result.html.indexOf('data-office-bot'),
  );
  expect(result.assets[0].body).toContain('var(--office-paper)');
  expect(result.assets[0].path).toMatch(/office-static-[a-f0-9]{16}\.svg/);
  expect(
    createStaticArtwork().extract(html, '.office-human-figure {}@media {}')
      .assets[0].path,
  ).not.toBe(result.assets[0].path);
});

it('extracts plain SVG geometry but leaves hydrated islands untouched', () => {
  const body = `<path d="${'M1 2L3 4 '.repeat(40)}" fill="currentColor"/>`;
  const result = createStaticArtwork().extract(
    `<svg class="klex-mascot">${body}</svg><div class="new-features-mount"><svg>${body}</svg></div>`,
    '.office-human-figure {}@media {}',
  );
  expect(result.assets).toHaveLength(1);
  expect(result.assets[0].path).toContain('artwork-static-');
  expect(result.html).toContain('<use href="/assets/artwork-static-');
  expect(result.html).toContain(
    `<div class="new-features-mount"><svg>${body}</svg></div>`,
  );
});

it('preserves substantial text while shrinking built office markup', async () => {
  const html = await readFile(
    new URL('../../apps/website/dist/index.html', import.meta.url),
    'utf8',
  );
  expect(html).toContain('office-static-');
  expect(html).toContain('data-office-bot=');
  expect(html.length).toBeLessThan(330000);
});
