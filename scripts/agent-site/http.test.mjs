import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const processes = [];
const origins = {
  marketing: 'http://127.0.0.1:4187',
  docs: 'http://127.0.0.1:4188',
};
beforeAll(async () => {
  await Promise.all(
    Object.entries(origins).map(async ([kind, origin]) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./preview.mjs', import.meta.url)),
          kind,
          '--port',
          new URL(origin).port,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      processes.push(child);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Preview startup timed out')),
          10000,
        );
        child.stdout.on('data', (data) => {
          if (String(data).includes('Local:')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Preview exited: ${code}`));
        });
      });
    }),
  );
});
afterAll(async () => {
  await Promise.all(
    processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid)
        return;
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }),
  );
});

const get = (kind, path, options = {}) =>
  fetch(`${origins[kind]}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });

describe('built routing over HTTP', () => {
  it('serves localized Markdown through packaged routing for both URL forms', async () => {
    for (const path of ['/', '/index.md', '/brand.md', '/press.md']) {
      const response = await get('marketing', path, {
        headers: { Accept: 'text/markdown', 'Accept-Language': 'de-DE' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/markdown');
      expect(response.headers.get('content-language')).toBe('de');
      expect(response.headers.get('vary')).toBe(
        'Accept, Accept-Language, Cookie',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body.length).toBeGreaterThan(100);
      if (path === '/' || path === '/index.md')
        expect(body).toContain('Dein eigenes Team');
      const head = await get('marketing', path, {
        method: 'HEAD',
        headers: {
          Accept: 'text/markdown',
          Cookie: 'klex-language=fr',
          'Accept-Language': 'de',
        },
      });
      expect(head.headers.get('content-language')).toBe('fr');
      expect(await head.text()).toBe('');
    }
  });
  it('permanently redirects legacy legal aliases to their canonical pages', async () => {
    for (const policy of ['terms', 'privacy']) {
      for (const suffix of ['', '/']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await get('marketing', `/${policy}${suffix}`, {
            method,
            redirect: 'manual',
            headers: { Accept: 'text/markdown' },
          });
          expect(response.status).toBe(308);
          expect(response.headers.get('location')).toBe(`/legal/${policy}`);
        }
      }
      const destination = await get('marketing', `/${policy}`, {
        headers: { Accept: 'text/markdown' },
      });
      expect(destination.status).toBe(200);
      expect(destination.headers.get('content-type')).toContain(
        'text/markdown',
      );
    }
  });
  it('serves emitted images and fonts with their actual MIME types', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(
      new URL('../../apps/website/.vercel/output/static/', import.meta.url),
      { recursive: true },
    );
    const expected = {
      '.webp': 'image/webp',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.ttf': 'font/ttf',
    };
    for (const [extension, type] of Object.entries(expected)) {
      for (const file of files.filter((file) => file.endsWith(extension))) {
        const response = await get(
          'marketing',
          `/${file.replaceAll('\\', '/')}`,
          { method: 'HEAD' },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(type);
      }
    }
  });
  it('only configures an API catalog where the artifact exists', async () => {
    const marketingConfig = JSON.parse(
      await readFile(
        new URL(
          '../../apps/website/.vercel/output/config.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(
      marketingConfig.routes.some(
        (route) =>
          route.headers?.['Content-Type'] === 'application/linkset+json',
      ),
    ).toBe(false);
    const response = await get('docs', '/.well-known/api-catalog');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/linkset+json',
    );
    expect(await response.json()).toHaveProperty('linkset');
  });
  it('serves content-hashed static geometry with immutable caching', async () => {
    const html = await (await get('marketing', '/')).text();
    const path = html.match(
      /href="(\/assets\/office-static-[a-f0-9]+\.svg)#/,
    )[1];
    const response = await get('marketing', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(await response.text()).toContain('geometry-0');
  });
  it('serves all static mascot assets with complete shapes and immutable caching', async () => {
    const html = await (await get('marketing', '/')).text();
    const paths = [
      ...new Set(
        [
          ...html.matchAll(/src="(\/assets\/mascot-static-[a-f0-9]+\.svg)"/g),
        ].map((match) => match[1]),
      ),
    ];
    expect(paths.length).toBeGreaterThan(2);
    expect(html.length).toBeLessThan(220000);
    for (const path of paths) {
      const response = await get('marketing', path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('immutable');
      const svg = await response.text();
      expect(svg).toContain('<path');
      expect(svg).toContain('<ellipse');
      expect(svg.length).toBeGreaterThan(1000);
    }
  });
  it('resolves every built marketing page asset and same-origin Markdown link', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          '../../apps/website/.vercel/output/functions/site.func/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const checked = new Set();
    for (const page of Object.values(manifest.pages)) {
      const urls = new Set(
        [...page.html.matchAll(/(?:src|href)="([^"#]+)(?:#[^"]*)?"/g)].map(
          (match) => match[1],
        ),
      );
      for (const url of urls) {
        const target = new URL(url, 'https://www.klex.bot');
        if (
          target.origin !== 'https://www.klex.bot' ||
          target.pathname.startsWith('/_vercel/')
        )
          continue;
        if (checked.has(target.pathname)) continue;
        checked.add(target.pathname);
        const response = await get('marketing', target.pathname, {
          method: 'HEAD',
        });
        expect(
          response.status,
          `${page.route}: ${target.pathname}`,
        ).toBeLessThan(400);
      }
      expect(page.html).toContain('<html lang="en">');
      expect(page.html).toContain(`href="${page.canonical}"`);
      if (page.markdown) expect(page.markdown).not.toContain('Canonical:');
    }
  });
  it('exposes every legal policy and approved revision as Markdown to agents', async () => {
    const catalogResponse = await get('marketing', '/legal/policies.json');
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    const center = await get('marketing', '/legal', {
      headers: { accept: 'text/markdown', 'user-agent': 'GPTBot' },
    });
    expect(center.headers.get('content-type')).toContain('text/markdown');
    const index = await center.text();
    const discovery = await (await get('marketing', '/llms.txt')).text();
    for (const [policy, revisions] of Object.entries(catalog.policies)) {
      expect(index).toContain(`/legal/${policy}`);
      expect(discovery).toContain(`/legal/${policy}.md`);
      const current = await get('marketing', `/legal/${policy}`, {
        headers: { accept: 'text/markdown', 'user-agent': 'ClaudeBot' },
      });
      expect(current.status).toBe(200);
      expect(current.headers.get('content-type')).toContain('text/markdown');
      expect(current.headers.get('vary')).toContain('Accept');
      const text = await current.text();
      expect(text).toContain('## ');
      const mirror = await get('marketing', `/legal/${policy}.md`);
      expect(await mirror.text()).toBe(text);
      for (const revision of revisions) {
        const path = `/legal/${policy}/${revision.revision}`;
        const original = await readFile(
          new URL(
            `../../apps/website/content/legal/${policy}/${revision.revision}.md`,
            import.meta.url,
          ),
        );
        for (const route of [path, `${path}.md`]) {
          const response = await get('marketing', route, {
            headers: { accept: 'text/markdown', 'user-agent': 'GPTBot' },
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain(
            'text/markdown',
          );
          expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
        }
      }
    }
  });
  it('alternates HTML and Markdown without cacheable variants', async () => {
    for (const accept of [
      'text/html',
      'text/markdown',
      'text/html',
      'text/markdown',
    ]) {
      const response = await get('marketing', '/', { headers: { accept } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(accept);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await response.text()).length).toBeGreaterThan(500);
    }
  });
  it.each(['marketing', 'docs'])('serves proper errors on %s', async (kind) => {
    for (const [accept, type] of [
      ['text/html', 'text/html'],
      ['text/markdown', 'text/markdown'],
      ['application/json', 'application/problem+json'],
    ]) {
      const response = await get(kind, '/nested/missing?tracking=x', {
        headers: { accept },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(type);
      expect((await response.text()).length).toBeGreaterThan(20);
    }
    const response = await get(kind, '/api/docs/pages/not-a-page.json');
    expect(response.status).toBe(404);
    expect((await response.json()).resolution).toContain(
      '/api/docs/pages.json',
    );
  });
  it('preserves scripts, assets, explicit Markdown, noindex, HEAD and redirects', async () => {
    for (const path of [
      '/install.sh',
      '/install.ps1',
      '/favicon.png',
      '/index.md',
      '/brand.md',
      '/press/',
    ]) {
      const response = await get('marketing', path);
      expect(response.status, path).toBe(200);
      const head = await get('marketing', path, { method: 'HEAD' });
      expect(head.status, path).toBe(200);
      expect(head.headers.get('content-length')).toBe(
        response.headers.get('content-length'),
      );
      expect(await head.text()).toBe('');
      if (path === '/brand.md' || path === '/press/')
        expect(response.headers.get('x-robots-tag')).toBe('noindex');
    }
    const redirect = await get('marketing', '/openapi.json', {
      redirect: 'manual',
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get('location')).toBe(
      'https://docs.klex.bot/openapi.json',
    );
  });
  it.each(['marketing', 'docs'])(
    'rejects mutations even for static resources on %s',
    async (kind) => {
      for (const path of ['/', '/llms.txt', '/api/docs/pages.json']) {
        const response = await get(kind, path, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, HEAD');
      }
    },
  );
  it('checks every docs index entry and its JSON schema', async () => {
    const spec = await (await get('docs', '/openapi.json')).json();
    const ajv = new Ajv({ strict: false, validateFormats: false });
    ajv.addSchema({
      $id: 'https://docs.klex.bot/schemas',
      components: spec.components,
    });
    const validate = ajv.compile({
      $ref: 'https://docs.klex.bot/schemas#/components/schemas/Page',
    });
    const index = await (await get('docs', '/api/docs/pages.json')).json();
    expect(index.count).toBe(index.pages.length);
    for (let offset = 0; offset < index.pages.length; offset += 4) {
      await Promise.all(
        index.pages.slice(offset, offset + 4).map(async (page) => {
          for (const field of ['url', 'markdownUrl', 'json']) {
            const path = new URL(page[field], 'https://docs.klex.bot').pathname;
            const response = await get('docs', path);
            expect(response.status, path).toBe(200);
            if (field === 'json')
              expect(
                validate(await response.json()),
                JSON.stringify(validate.errors),
              ).toBe(true);
            else
              expect((await response.text()).length, path).toBeGreaterThan(20);
          }
        }),
      );
    }
  }, 30000);
  it.each(['marketing', 'docs'])(
    'validates discovery and sitemap targets on %s',
    async (kind) => {
      for (const path of [
        '/llms.txt',
        '/llms-full.txt',
        '/agent-readability.json',
        '/robots.txt',
      ]) {
        const response = await get(kind, path);
        expect(response.status, path).toBe(200);
        const body = await response.text();
        expect(body.length).toBeGreaterThan(20);
        if (path.endsWith('.json')) expect(JSON.parse(body)).toBeDefined();
      }
      const sitemap = await (await get(kind, '/sitemap.xml')).text();
      expect(sitemap).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
      const entries = [
        ...sitemap.matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g),
      ];
      expect(entries.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(sitemap)).toBeLessThan(50000000);
      for (let offset = 0; offset < entries.length; offset += 4) {
        await Promise.all(
          entries.slice(offset, offset + 4).map(async ([, url, date]) => {
            expect(new URL(url).host).toBe(
              kind === 'docs' ? 'docs.klex.bot' : 'www.klex.bot',
            );
            expect(Number.isNaN(Date.parse(date))).toBe(false);
            expect((await get(kind, new URL(url).pathname)).status, url).toBe(
              200,
            );
          }),
        );
      }
      for (const path of ['/404.html', '/404.json', '/404.md'])
        expect((await get(kind, path)).status).toBe(404);
    },
  );
  it('verifies every concrete OpenAPI operation response', async () => {
    const spec = await (await get('docs', '/openapi.json')).json();
    const ajv = new Ajv({ strict: false, validateFormats: false });
    ajv.addSchema({ $id: 'https://docs.klex.bot/openapi.json', ...spec });
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path.includes('{')) continue;
      const response = await get('docs', path);
      expect(response.status, path).toBe(200);
      const content = item.get.responses['200'].content;
      const type = Object.keys(content)[0];
      expect(response.headers.get('content-type'), path).toContain(type);
      const body = type.includes('json')
        ? await response.json()
        : await response.text();
      const validate = ajv.compile({
        ...content[type].schema,
        $id: `https://docs.klex.bot/test-${encodeURIComponent(path)}`,
        ...(content[type].schema.$ref
          ? {
              $ref: `https://docs.klex.bot/openapi.json${content[type].schema.$ref}`,
            }
          : {}),
      });
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it('checks OpenAPI operation IDs and local references', async () => {
    const spec = JSON.parse(
      await readFile(
        new URL('../../apps/docs/dist/openapi.json', import.meta.url),
        'utf8',
      ),
    );
    const ids = [];
    for (const path of Object.values(spec.paths)) {
      for (const operation of Object.values(path)) {
        expect(operation.description.length).toBeGreaterThan(10);
        ids.push(operation.operationId);
        expect(operation.responses['200']).toBeDefined();
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.$ref?.startsWith('#/')) {
        const target = value.$ref
          .slice(2)
          .split('/')
          .reduce((result, key) => result?.[key], spec);
        expect(target, value.$ref).toBeDefined();
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(spec);
  });
});
