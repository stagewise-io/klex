import { readFile } from 'node:fs/promises';

import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { createSiteContent } from './content.mjs';
import { createAgentSite } from './runtime.mjs';

const manifest = JSON.parse(
  await readFile(
    new URL(
      '../../apps/website/.vercel/output/functions/site.func/manifest.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const site = createAgentSite(manifest);
const request = (url, accept, method = 'GET') =>
  site.response({
    url,
    method,
    headers: accept === undefined ? {} : { accept },
  });

describe('representation negotiation', () => {
  it.each([
    undefined,
    '*/*',
    'text/html',
    'text/html,text/markdown',
    'text/markdown;q=0,*/*;q=1',
    'text/markdown;q=bad,text/html',
  ])('keeps HTML for %s', (accept) => {
    const result = request('/', accept);
    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toContain('text/html');
    expect(result.body).toContain('<main');
  });
  it.each([
    'text/markdown',
    'text/html;q=0.2,text/markdown;q=0.9',
    'TEXT/MARKDOWN',
    'text/markdown ;q=1',
    'text/html ; q=0.1, text/markdown ; q=0.9',
    'text/html;q=0,text/*;q=0.5',
  ])('returns Markdown for %s', (accept) => {
    const result = request('/?tracking=test', accept);
    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toContain('text/markdown');
    expect(result.headers.Vary).toBe('Accept');
    expect(result.headers['CDN-Cache-Control']).toBe('no-store');
    expect(result.body).toContain('# Your own team of digital coworkers.');
    expect(result.body).not.toContain('<svg');
    expect(result.body).toContain('They can only see through connectors');
    expect(result.body).toContain('Ask them to set up a schedule');
  });
  it('rejects unsupported representations', () =>
    expect(request('/', 'application/pdf').status).toBe(406));
  it.each(['/brand', '/brand/', '/brand/index.html', '/press?source=test'])(
    'preserves noindex on %s',
    (url) =>
      expect(request(url, 'text/markdown').headers['X-Robots-Tag']).toBe(
        'noindex',
      ),
  );
  it.each(['text/html', 'text/markdown', 'application/json'])(
    'keeps missing routes as true 404 for %s',
    (accept) => {
      const result = request('/nested/missing?private=not-reflected', accept);
      expect(result.status).toBe(404);
      expect(result.body.length).toBeGreaterThan(20);
      expect(result.body).not.toContain('not-reflected');
    },
  );
  it('does not treat inherited object keys as pages', () =>
    expect(request('/constructor').status).toBe(404));
  it('provides HEAD parity', () => {
    const get = request('/', 'text/markdown');
    const head = request('/', 'text/markdown', 'HEAD');
    expect(head.body).toBe('');
    expect(head.headers).toEqual(get.headers);
  });
  it('rejects mutation methods', () => {
    const result = request('/', 'application/json', 'POST');
    expect(result.status).toBe(405);
    expect(result.headers.Allow).toBe('GET, HEAD');
  });
  it('matches the published docs Problem schema', async () => {
    const spec = JSON.parse(
      await readFile(
        new URL('../../apps/docs/dist/openapi.json', import.meta.url),
        'utf8',
      ),
    );
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(spec.components.schemas.Problem);
    const result = request('/api/docs/pages/missing.json');
    expect(result.status).toBe(404);
    expect(result.headers['Content-Type']).toContain(
      'application/problem+json',
    );
    expect(validate(JSON.parse(result.body))).toBe(true);
  });
});

describe('generated artifacts', () => {
  it('measures meaningful raw content and decorative SVG separately', () => {
    const report = createSiteContent().measure(
      '<main><h1>Product</h1><p>Useful content</p><svg><text>Decoration</text></svg><h3>Skipped</h3></main>',
    );
    expect(report.h1Count).toBe(1);
    expect(report.svgCharacters).toBeGreaterThan(20);
    expect(report.headingSkips).toEqual([{ from: 1, to: 3 }]);
    expect(report.meaningfulTextCharacters).toBe(
      'Product Useful content Skipped'.length,
    );
  });
  it('retains substantial homepage content without JavaScript', () => {
    const report = createSiteContent().measure(manifest.pages['/'].html);
    expect(report.h1Count).toBe(1);
    expect(report.headingSkips).toEqual([]);
    expect(report.meaningfulTextCharacters).toBeGreaterThan(500);
    const markdown = manifest.pages['/'].markdown;
    expect(markdown).not.toContain('01020304');
    expect(markdown).not.toContain('BotsPersonal');
    expect(markdown).toContain(
      'Kristine (Klex Bot) creates a ticket in Linear',
    );
    expect(markdown).toContain('Jeff (Klex Bot), your QA Klex Bot, tests');
    for (const step of [1, 2, 3, 4])
      expect(markdown).toContain(`### Step ${step}:`);
    expect(markdown).toContain(
      '## Best practices for building a Bot-native team.',
    );
    expect(markdown).toContain('**Personal AI Assistant:**');
    expect(markdown).toContain('## Klex Bots\n\n### Right where work happens');
    expect(markdown).not.toContain('Hover over a Klex Bot');
    expect(markdown).toContain('SOC 2 Type 2: Audit underway');
    expect(markdown).toContain('ISO 27001: Certification underway');
  });
  it('keeps the sitemap scoped and excludes noindex pages', async () => {
    const sitemap = await readFile(
      new URL('../../apps/website/dist/sitemap.xml', import.meta.url),
      'utf8',
    );
    expect(sitemap).toContain(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    );
    expect(sitemap).toContain('<loc>https://www.klex.bot/</loc>');
    expect(sitemap).not.toMatch(/brand|press|docs\.klex/);
  });
  it('emits linked truthful JSON-LD and canonical URLs', () => {
    const html = manifest.pages['/'].html;
    const schema = JSON.parse(
      html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1],
    );
    expect(schema['@graph'].map((entity) => entity['@type'])).toEqual([
      'Organization',
      'SoftwareApplication',
    ]);
    expect(html).toContain('href="https://www.klex.bot/"');
    expect(html).not.toContain('https://klex.bot/');
    expect(schema['@graph'][0]).not.toHaveProperty('address');
    expect(schema['@graph'][0].name).toBe('stagewise GmbH');
    expect(schema['@graph'][0].contactPoint).toMatchObject({
      email: 'support@klex.bot',
      contactType: 'Customer support',
    });
  });
  it('extracts content, links, headings, and button-based FAQ text without decoration', () => {
    const content = createSiteContent();
    const markdown = content.markdown(
      '<main><h1>A<br>B</h1><h2><svg></svg></h2><button>FAQ question</button><p>Answer <a href="/guide">guide</a></p><div aria-hidden="true">Ignore</div></main>',
      'https://www.klex.bot/',
    );
    expect(markdown).toContain('# A B');
    expect(markdown).toContain('FAQ question');
    expect(markdown).toContain('[guide](https://www.klex.bot/guide)');
    expect(markdown).not.toContain('Ignore');
    expect(markdown).not.toContain('##');
  });
});
