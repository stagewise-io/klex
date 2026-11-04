import artwork from 'virtual:klex-static-mascots';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { ProgressiveMascot } from './progressive-mascot';
import { StaticMascot } from './static-mascot';

it('prerenders animated mascots as cached image placeholders without animation SVG', () => {
  const html = renderToStaticMarkup(
    <ProgressiveMascot snapshot="brand" size={54} width={254} layout="track" />,
  );
  expect(html).toContain('data-mascot-fallback');
  expect(html).toContain('mascot-static-');
  expect(html).toContain('width:254px');
  expect(html).not.toContain('<svg');
  expect(html).toContain('top:0');
});

it('renders hashed assets identically for server and client without inline geometry', () => {
  const html = renderToStaticMarkup(<StaticMascot name="monica" size={64} />);
  expect(html).toContain('/assets/mascot-static-');
  expect(html).not.toContain('<svg');
  expect(html).toContain('width="64"');
  expect(html).not.toContain('translateY');
  expect(
    new Set(Object.values(artwork).map((asset) => asset.src)).size,
  ).toBeGreaterThan(2);
});
