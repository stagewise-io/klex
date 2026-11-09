import { describe, expect, it } from 'vitest';

import { createDiscoveryPolicy } from './policy.mjs';
import { createAgentSite } from './runtime.mjs';

describe('discovery exclusion policy', () => {
  it('keeps all current policies by default', () => {
    const policy = createDiscoveryPolicy({
      sitemap: [],
      agents: [],
      markdown: [],
    });
    for (const surface of ['sitemap', 'agents', 'markdown'])
      expect(policy.includes(surface, '/brand')).toBe(true);
  });
  it('separates surfaces and supports exact, single-segment, and recursive patterns', () => {
    const policy = createDiscoveryPolicy({
      sitemap: ['/brand'],
      agents: ['/internal/**'],
      markdown: ['/draft/*'],
    });
    expect(policy.includes('sitemap', '/brand/')).toBe(false);
    expect(policy.includes('agents', '/brand')).toBe(true);
    expect(policy.includes('agents', '/internal/nested/page')).toBe(false);
    expect(policy.includes('markdown', '/draft/page')).toBe(false);
    expect(policy.includes('markdown', '/draft/nested/page')).toBe(true);
    expect(policy.includes('agents', '/internal-other/page')).toBe(true);
  });
  it('requires a nonempty segment for standalone stars on every surface', () => {
    for (const surface of ['sitemap', 'agents', 'markdown']) {
      const single = createDiscoveryPolicy({ [surface]: ['/*'] });
      expect(single.includes(surface, '/')).toBe(true);
      expect(single.includes(surface, '/legal')).toBe(false);
      expect(single.includes(surface, '/legal/privacy')).toBe(true);
      const nested = createDiscoveryPolicy({ [surface]: ['/legal/*'] });
      expect(nested.includes(surface, '/legal/')).toBe(true);
      expect(nested.includes(surface, '/legal/privacy')).toBe(false);
      expect(nested.includes(surface, '/legal/privacy/revision')).toBe(true);
      const recursive = createDiscoveryPolicy({ [surface]: ['/**'] });
      expect(recursive.includes(surface, '/')).toBe(false);
      expect(recursive.includes(surface, '/legal/privacy')).toBe(false);
    }
  });
  it('matches globstars with zero, one, or multiple path segments', () => {
    const policy = createDiscoveryPolicy({
      agents: ['/docs/**/guide', '/internal/**'],
    });
    for (const route of [
      '/docs/guide',
      '/docs/a/guide',
      '/docs/a/b/guide',
      '/internal',
      '/internal/a',
    ])
      expect(policy.includes('agents', route)).toBe(false);
    expect(policy.includes('agents', '/docs/guidebook')).toBe(true);
    expect(policy.includes('agents', '/other/docs/guide')).toBe(true);
  });
  it.each([
    { typo: [] },
    { sitemap: 'bad' },
    { agents: ['relative'] },
    { markdown: ['/?query'] },
    null,
  ])('rejects invalid configuration %j', (configuration) => {
    expect(() => createDiscoveryPolicy(configuration)).toThrow();
  });
  it('does not negotiate or advertise excluded Markdown', () => {
    const site = createAgentSite({
      origin: 'https://www.klex.bot',
      pages: {
        '/': {
          html: '<main>HTML</main>',
          canonical: 'https://www.klex.bot/',
          markdownPath: '/index.md',
          markdown: null,
        },
      },
    });
    expect(
      site.response({ url: '/', headers: { accept: 'text/markdown' } }).status,
    ).toBe(406);
    const response = site.response({
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.Link).not.toContain(
      'rel="alternate"; type="text/markdown"',
    );
  });
});
