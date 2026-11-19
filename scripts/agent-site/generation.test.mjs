import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createAgentBuild } from './agent-site.mjs';

it('discovers new emitted marketing pages and applies each exclusion independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'klex-discovery-'));
  const save = async (path, body) => {
    const target = join(directory, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  };
  const html = (title) =>
    `<html><head><title>${title}</title><meta name="description" content="${title} description"></head><body><main><h1>${title}</h1><p>Meaningful product content.</p></main></body></html>`;
  try {
    await save('dist/index.html', html('Home'));
    await save('dist/new-page/index.html', html('New page'));
    await save(
      'dist/asset.html',
      '<html><body>Not a content page</body></html>',
    );
    await save(
      'discovery.config.json',
      JSON.stringify({
        sitemap: ['/new-page'],
        agents: ['/new-page'],
        markdown: ['/new-page'],
      }),
    );
    await createAgentBuild({ kind: 'marketing', directory }).build();
    const guidance = await readFile(join(directory, 'dist/llms.txt'), 'utf8');
    expect(guidance).toContain('https://docs.klex.bot/bot/quickstart.md');
    expect(guidance).toContain(
      'https://docs.klex.bot/bot/concepts/how-bots-work.md',
    );
    expect(guidance).not.toContain('https://docs.klex.bot/quickstart.md');
    expect(guidance).not.toContain('https://docs.klex.bot/architecture.md');
    const manifest = JSON.parse(
      await readFile(
        join(directory, '.vercel/output/functions/site.func/manifest.json'),
        'utf8',
      ),
    );
    expect(Object.keys(manifest.pages)).toEqual(['/', '/new-page']);
    expect(manifest.pages['/new-page'].html).toContain('New page');
    expect(manifest.pages['/new-page'].markdown).toBeNull();
    expect(manifest.pages['/new-page'].html).not.toContain(
      'type="text/markdown"',
    );
    expect(
      await readFile(join(directory, 'dist/llms.txt'), 'utf8'),
    ).not.toContain('New page');
    expect(
      await readFile(join(directory, 'dist/llms-full.txt'), 'utf8'),
    ).not.toContain('New page');
    expect(
      await readFile(join(directory, 'dist/sitemap.xml'), 'utf8'),
    ).not.toContain('/new-page');
    await expect(
      readFile(join(directory, 'dist/new-page.md')),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('filters docs aggregates and removes Markdown mirrors without removing HTML pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'klex-docs-discovery-'));
  const save = async (path, body) => {
    const target = join(directory, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(
      target,
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };
  try {
    const pages = [
      '/',
      '/bot/quickstart',
      '/bot/concepts/how-bots-work',
      '/de/bot/quickstart',
      '/bot/concepts/cognitive-architecture',
      '/de/bot/concepts/cognitive-architecture',
      '/guides/limit-blast-radius',
    ].map((route) => ({
      route,
      title: route === '/' ? 'Introduction' : route.slice(1),
      url: `https://docs.klex.bot${route}`,
      json: `https://docs.klex.bot/api/docs/pages/${route === '/' ? 'index' : route.slice(1)}.json`,
      markdownUrl: `https://docs.klex.bot/${route === '/' ? 'index' : route.slice(1)}.md`,
      locale: 'en',
    }));
    await save('docs/index.mdx', '# Introduction');
    await save('docs/bot/01-quickstart.mdx', '# Quickstart');
    await save('docs/de/bot/01-quickstart.mdx', '# Schnellstart');
    await save('docs/bot/concepts/01-how-bots-work.mdx', '# Architecture');
    await save('docs/bot/concepts/12-cognitive-architecture.mdx', '# Sessions');
    await save(
      'docs/de/bot/concepts/01-cognitive-architecture.mdx',
      '# Sitzungen',
    );
    // Blume route groups do not appear in the published URL.
    await save(
      'docs/guides/(security)/limit-blast-radius.mdx',
      '# Limit blast radius',
    );
    await save('discovery.config.json', {
      sitemap: ['/bot/concepts/how-bots-work'],
      agents: ['/bot/quickstart'],
      markdown: ['/bot/concepts/how-bots-work'],
    });
    await save('dist/agent-readability.json', {
      description: 'Docs',
      artifacts: {},
    });
    await save('dist/api/docs/pages.json', { count: pages.length, pages });
    await save(
      'dist/sitemap.xml',
      `<urlset>${pages.map((page) => `<url><loc>${page.url}</loc></url>`).join('')}</urlset>`,
    );
    for (const page of pages) {
      await save(`dist/${new URL(page.json).pathname.slice(1)}`, {
        ...page,
        markdown: `Unique body for ${page.title}`,
      });
      await save(
        `dist/${new URL(page.markdownUrl).pathname.slice(1)}`,
        '# Mirror',
      );
      await save(
        `dist/${new URL(page.markdownUrl).pathname.slice(1)}x`,
        '# Source',
      );
      await save(
        `dist/${page.route === '/' ? 'index.html' : `${page.route.slice(1)}/index.html`}`,
        `<html><head><link rel="alternate" type="text/markdown" href="${page.markdownUrl}"></head><body><main>Content</main></body></html>`,
      );
    }
    await createAgentBuild({ kind: 'docs', directory }).build();
    const llms = await readFile(join(directory, 'dist/llms.txt'), 'utf8');
    expect(llms).not.toContain('https://docs.klex.bot/bot/quickstart');
    expect(llms).toContain('/guides/limit-blast-radius');
    expect(llms).toContain(
      '[bot/concepts/how-bots-work](https://docs.klex.bot/bot/concepts/how-bots-work)',
    );
    const full = await readFile(join(directory, 'dist/llms-full.txt'), 'utf8');
    expect(full).not.toContain('Unique body for bot/quickstart');
    expect(full).toContain('Unique body for bot/concepts/how-bots-work');
    await expect(
      readFile(join(directory, 'dist/bot/concepts/how-bots-work.md')),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(directory, 'dist/bot/concepts/how-bots-work/index.html'),
        'utf8',
      ),
    ).not.toContain('type="text/markdown"');
    expect(
      await readFile(join(directory, 'dist/sitemap.xml'), 'utf8'),
    ).not.toContain('/bot/concepts/how-bots-work');
    const routes = JSON.parse(
      await readFile(join(directory, '.vercel/output/config.json'), 'utf8'),
    ).routes;
    expect(
      routes.some(
        (route) => route.dest === '/bot/concepts/how-bots-work/index.html',
      ),
    ).toBe(true);
    for (const prefix of ['', '/de']) {
      expect(routes).toContainEqual({
        src: `^${prefix}/quickstart/?$`,
        dest: `${prefix}/quickstart/index.html`,
      });
      expect(routes).toContainEqual({
        src: `^${prefix}/concepts/cognitive-architecture/?$`,
        dest: `${prefix}/concepts/cognitive-architecture/index.html`,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
