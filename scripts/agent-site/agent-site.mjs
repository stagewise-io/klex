import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticArtwork } from './artwork.mjs';
import { createSiteContent } from './content.mjs';
import { createDiscoveryPolicy } from './policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const marketingOrigin = 'https://www.klex.bot';
const docsOrigin = 'https://docs.klex.bot';
const guidance = `## When to use

Use Klex for autonomous digital coworkers with durable memory and identities, connected to channels, tools, and external computers through MCP. Read the quickstart before self-hosting; the runtime requires Node.js 26. Connect external work environments rather than treating the agent's brain VM as a general-purpose work machine.

This website and the documentation API are public, read-only information sources. They do not run tasks or administer bots. Product operation requires your own configured Klex deployment and authenticated admin access. The documentation does not expose a public MCP server.

## Documentation

- [Quickstart](https://docs.klex.bot/quickstart.md): installation and prerequisites
- [Architecture](https://docs.klex.bot/architecture.md): brain, durable state, and MCP boundaries
- [Documentation index](https://docs.klex.bot/llms.txt): all available documentation
- [Documentation pages API](https://docs.klex.bot/api/docs/pages.json): enumerate real routes
- [OpenAPI](https://docs.klex.bot/openapi.json): read-only docs operations and schemas
- [Source repository](https://github.com/stagewise-io/klex): code and Apache-2.0 license
`;

class AgentBuild {
  constructor({ kind, directory }) {
    this.kind = kind;
    this.directory =
      directory ??
      resolve(root, kind === 'marketing' ? 'apps/website' : 'apps/docs');
    this.origin = kind === 'marketing' ? marketingOrigin : docsOrigin;
    this.content = createSiteContent();
  }

  guidance() {
    if (this.kind !== 'docs') return guidance;
    return guidance
      .split('\n')
      .filter((line) => {
        const match = line.match(
          /\]\(https:\/\/docs\.klex\.bot(\/[^)]+\.md)\)/,
        );
        return (
          !match ||
          this.policy.includes('agents', match[1].replace(/\.md$/, ''))
        );
      })
      .map((line) =>
        line.replace(
          /\]\(https:\/\/docs\.klex\.bot(\/[^)]+)\.md\)/g,
          (match, route) =>
            this.policy.includes('markdown', route)
              ? match
              : `](https://docs.klex.bot${route})`,
        ),
      )
      .join('\n');
  }

  async save(path, content) {
    const target = resolve(this.directory, 'dist', path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(
      target,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }

  lastModified(paths) {
    const result = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', ...paths],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    if (!result || Number.isNaN(Date.parse(result)))
      throw new Error(
        `Missing committed content timestamp: ${paths.join(', ')}`,
      );
    return new Date(result).toISOString();
  }

  async marketing() {
    const pages = {};
    // Discover actual emitted content pages, rather than maintaining a second route list.
    const files = await readdir(resolve(this.directory, 'dist'), {
      recursive: true,
    });
    const inventory = [];
    for (const file of files.filter((file) => file.endsWith('.html')).sort()) {
      const html = await readFile(
        resolve(this.directory, 'dist', file),
        'utf8',
      );
      if (!this.content.hasMain(html) || file === '404.html') continue;
      const route = `/${file
        .replaceAll('\\', '/')
        .replace(/(?:^|\/)index\.html$/, '')
        .replace(/\.html$/, '')
        .replace(/\/$/, '')}`;
      inventory.push({
        route,
        file,
        markdownPath: route === '/' ? '/index.md' : `${route}.md`,
        sources: file.startsWith('legal/')
          ? ['apps/website/content/legal', 'apps/website/src/legal']
          : ['apps/website/src/new', `apps/website/${file}`],
      });
    }
    if (!inventory.some((page) => page.route === '/'))
      throw new Error('Missing marketing homepage');
    for (const entry of inventory) {
      const canonical = `${this.origin}${entry.route}`;
      let html = await readFile(
        resolve(this.directory, 'dist', entry.file),
        'utf8',
      );
      html = html.replaceAll('https://klex.bot', this.origin);
      if (entry.route === '/') {
        const officeStyles = await readFile(
          resolve(root, 'apps/website/src/new/sections/trust/office.css'),
          'utf8',
        );
        const extracted = createStaticArtwork().extract(html, officeStyles);
        html = extracted.html;
        for (const asset of extracted.assets)
          await this.save(asset.path, asset.body);
      }
      html = html
        .replace(/<link\b[^>]*rel="canonical"[^>]*>/g, '')
        .replace(/<meta\b[^>]*property="og:url"[^>]*>/g, '');
      html = html.replace(
        '</head>',
        `<link rel="canonical" href="${canonical}" /><meta property="og:url" content="${canonical}" /></head>`,
      );
      const metadata = this.content.metadata(html);
      const markdownEnabled = this.policy.includes('markdown', entry.route);
      const alternate = `${markdownEnabled ? `<link rel="alternate" type="text/markdown" href="${this.origin}${entry.markdownPath}" />\n` : ''}<link rel="alternate" type="text/plain" href="${this.origin}/llms.txt" />\n<link rel="service-desc" type="application/vnd.oai.openapi+json;version=3.1" href="https://docs.klex.bot/openapi.json" />`;
      if (entry.route === '/') {
        const organization = {
          '@type': 'Organization',
          '@id': `${this.origin}/#organization`,
          name: 'stagewise GmbH',
          contactPoint: {
            '@type': 'ContactPoint',
            email: 'support@klex.bot',
            contactType: 'Customer support',
          },
          url: 'https://stagewise.io',
          sameAs: ['https://github.com/stagewise-io'],
        };
        const application = {
          '@type': 'SoftwareApplication',
          '@id': `${this.origin}/#software`,
          name: 'Klex',
          url: `${this.origin}/`,
          description: metadata.description,
          applicationCategory: 'BusinessApplication',
          operatingSystem: 'Node.js',
          license: 'https://github.com/stagewise-io/klex/blob/main/LICENSE',
          sameAs: ['https://github.com/stagewise-io/klex'],
          keywords: [
            'digital coworkers',
            'open source',
            'self-hosted',
            'autonomous agents',
            'MCP',
          ],
          publisher: { '@id': organization['@id'] },
        };
        const schema = {
          '@context': 'https://schema.org',
          '@graph': [organization, application],
        };
        html = html.replace(
          '</head>',
          `<script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>\n</head>`,
        );
      }
      html = html.replace('</head>', `${alternate}\n</head>`);
      // Dated legal Markdown is the approved source artifact, with catalog hashes.
      // Never replace its bytes with an HTML-derived representation.
      let markdown;
      if (/^\/legal\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(entry.route)) {
        markdown = await readFile(
          resolve(this.directory, 'dist', entry.markdownPath.slice(1)),
          'utf8',
        );
      } else markdown = this.content.markdown(html, canonical);
      pages[entry.route] = {
        ...entry,
        ...metadata,
        canonical,
        markdown: markdownEnabled ? markdown : null,
        agentMarkdown: markdown,
        html,
        lastModified: this.lastModified(entry.sources),
      };
      await this.save(entry.file, html);
      if (markdownEnabled)
        await this.save(entry.markdownPath.slice(1), markdown);
    }
    await this.save(
      'sitemap.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.values(
        pages,
      )
        .filter(
          (page) =>
            !page.noindex && this.policy.includes('sitemap', page.route),
        )
        .map(
          (page) =>
            `<url><loc>${page.canonical}</loc><lastmod>${page.lastModified}</lastmod></url>`,
        )
        .join('')}</urlset>\n`,
    );
    await this.save(
      'robots.txt',
      `User-agent: *\nAllow: /\n\nSitemap: ${this.origin}/sitemap.xml\n`,
    );
    await this.save(
      'llms.txt',
      `# Klex\n\n> Klex is an open-source platform for digital coworkers with durable memory and identities, built by stagewise.\n\n${this.guidance()}\n## Marketing pages\n\n${Object.values(
        pages,
      )
        .filter((page) => this.policy.includes('agents', page.route))
        .map(
          (page) =>
            `- [${page.title}](${page.markdown ? `${this.origin}${page.markdownPath}` : page.canonical}): ${page.description}`,
        )
        .join('\n')}\n`,
    );
    await this.save(
      'llms-full.txt',
      `${this.guidance()}\n${Object.values(pages)
        .filter((page) => this.policy.includes('agents', page.route))
        .map((page) => page.agentMarkdown)
        .join('\n\n')}`,
    );
    await this.save('agent-readability.json', {
      name: 'Klex',
      description:
        'Read-only website and documentation discovery; not a bot execution API.',
      whenToUse:
        'Learn about Klex digital coworkers, self-hosting, durable memory, and MCP environments.',
      documentation: `${docsOrigin}/llms.txt`,
      openapi: `${docsOrigin}/openapi.json`,
      pages: `${docsOrigin}/api/docs/pages.json`,
      exclusions: this.policy.configuration,
      markdown: Object.values(pages)
        .filter(
          (page) => page.markdown && this.policy.includes('agents', page.route),
        )
        .map((page) => `${this.origin}${page.markdownPath}`),
      sitemap: `${this.origin}/sitemap.xml`,
    });
    return pages;
  }

  async documentation() {
    // Regenerate discovery from Blume's emitted page index on every clean build.
    const manifest = JSON.parse(
      await readFile(
        resolve(this.directory, 'dist/agent-readability.json'),
        'utf8',
      ),
    );

    const files = await readdir(resolve(this.directory, 'docs'), {
      recursive: true,
    });
    const sources = new Map(
      files
        .filter((file) => /\.mdx?$/.test(file))
        .map((file) => {
          const route =
            `/${file
              .replace(/\\/g, '/')
              .replace(/\.mdx?$/, '')
              .split('/')
              .map((part) => part.replace(/^\d+-/, ''))
              .join('/')}`.replace(/\/index$/, '') || '/';
          return [route, `apps/docs/docs/${file}`];
        }),
    );
    const index = JSON.parse(
      await readFile(
        resolve(this.directory, 'dist/api/docs/pages.json'),
        'utf8',
      ),
    );
    this.docsPages = index.pages;
    const agentPages = [];
    const fullText = [];
    for (const page of index.pages) {
      // Blume serves default-locale content for untranslated pages.
      const source =
        sources.get(page.route) ??
        (page.locale !== 'en'
          ? sources.get(
              page.route.replace(new RegExp(`^/${page.locale}(?=/|$)`), '') ||
                '/',
            )
          : undefined);
      if (!source)
        throw new Error(`No source timestamp for docs route ${page.route}`);
      page.lastModified = this.lastModified([source]);
      const path = new URL(page.json).pathname.slice(1);
      const full = JSON.parse(
        await readFile(resolve(this.directory, 'dist', path), 'utf8'),
      );
      await this.save(path, { ...full, lastModified: page.lastModified });
      const htmlFile =
        page.route === '/' ? 'index.html' : `${page.route.slice(1)}/index.html`;
      let html = await readFile(
        resolve(this.directory, 'dist', htmlFile),
        'utf8',
      );
      html = html.replace(
        /(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/g,
        (_match, start, body, end) => {
          const schema = JSON.parse(body);
          const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (
              node['@type'] === 'Organization' &&
              node.name === 'stagewise GmbH'
            )
              node.contactPoint = {
                '@type': 'ContactPoint',
                email: 'support@klex.bot',
                contactType: 'Customer support',
              };
            for (const value of Object.values(node))
              if (value && typeof value === 'object') visit(value);
          };
          visit(schema);
          return `${start}${JSON.stringify(schema).replaceAll('<', '\\u003c')}${end}`;
        },
      );
      if (!this.policy.includes('markdown', page.route))
        html = html.replace(/<link\b[^>]*>/g, (tag) =>
          /rel="alternate"/.test(tag) && /type="text\/markdown"/.test(tag)
            ? ''
            : tag,
        );
      await this.save(htmlFile, html);
      if (
        this.policy.includes('agents', page.route) &&
        this.policy.includes('markdown', page.route)
      )
        agentPages.push(page);
      if (this.policy.includes('agents', page.route))
        fullText.push(
          `# ${page.title}\nSource: ${page.url}\n\n${full.markdown}`,
        );
      if (!this.policy.includes('markdown', page.route)) {
        const markdownPath = new URL(page.markdownUrl).pathname.slice(1);
        await rm(resolve(this.directory, 'dist', markdownPath), {
          force: true,
        });
        await rm(
          resolve(
            this.directory,
            'dist',
            markdownPath.replace(/\.md$/, '.mdx'),
          ),
          { force: true },
        );
      }
    }
    await this.save('api/docs/pages.json', {
      ...index,
      pages: agentPages,
      count: agentPages.length,
    });
    await this.save(
      'llms.txt',
      `# Klex Docs\n\n> ${manifest.description}\n\n${this.guidance()}\n## Pages\n\n${index.pages
        .filter((page) => this.policy.includes('agents', page.route))
        .map(
          (page) =>
            `- [${page.title}](${this.policy.includes('markdown', page.route) ? page.markdownUrl : page.url})${page.description ? `: ${page.description}` : ''}`,
        )
        .join('\n')}\n`,
    );
    await this.save(
      'llms-full.txt',
      `# Klex Docs\n\n> ${manifest.description}\n\n${this.guidance()}\n\n${fullText.join('\n\n---\n\n')}`,
    );
    await this.save('agent-readability.json', {
      ...manifest,
      whenToUse:
        'Install, configure, and operate Klex; the public API reads documentation only.',
      exclusions: this.policy.configuration,
      pages: index.pages
        .filter((page) => this.policy.includes('agents', page.route))
        .map((page) => page.url),
    });
    const sitemap = await readFile(
      resolve(this.directory, 'dist/sitemap.xml'),
      'utf8',
    );
    const dates = new Map(
      index.pages.map((page) => [
        page.url.replace(/\/$/, ''),
        page.lastModified,
      ]),
    );
    await this.save(
      'sitemap.xml',
      sitemap
        .replace(/<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (entry, url) =>
          this.policy.includes('sitemap', new URL(url).pathname) ? entry : '',
        )
        .replace(
          /<url><loc>([^<]+)<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?/g,
          (match, url) => {
            const date = dates.get(url.replace(/\/$/, ''));
            return date
              ? `<url><loc>${url}</loc><lastmod>${date}</lastmod>`
              : match;
          },
        ),
    );
    return {};
  }

  async package(pages) {
    const output = resolve(this.directory, '.vercel/output');
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await cp(resolve(this.directory, 'dist'), resolve(output, 'static'), {
      recursive: true,
    });
    const functionDirectory = resolve(output, 'functions/site.func');
    await mkdir(functionDirectory, { recursive: true });
    const errorHtml = await readFile(
      new URL('./error.html', import.meta.url),
      'utf8',
    );
    const manifest = { origin: this.origin, pages, errorHtml };
    await this.save(
      '404.html',
      errorHtml
        .replaceAll('STATUS_PLACEHOLDER', '404')
        .replaceAll('MESSAGE_PLACEHOLDER', 'This page could not be found.')
        .replaceAll(
          'SUGGESTION_PLACEHOLDER',
          'Use the links below to find your way back.',
        ),
    );
    await cp(
      resolve(this.directory, 'dist/404.html'),
      resolve(output, 'static/404.html'),
    );
    await writeFile(
      resolve(functionDirectory, 'manifest.json'),
      JSON.stringify(manifest),
    );
    await cp(
      new URL('./cloud-status.mjs', import.meta.url),
      resolve(functionDirectory, 'cloud-status.mjs'),
    );
    await cp(
      new URL('./runtime.mjs', import.meta.url),
      resolve(functionDirectory, 'runtime.mjs'),
    );
    await writeFile(
      resolve(functionDirectory, '.vc-config.json'),
      JSON.stringify({
        runtime: 'nodejs24.x',
        handler: 'runtime.mjs',
        launcherType: 'Nodejs',
      }),
    );
    const routes = [
      {
        src: '^/assets/[^/]+-[A-Za-z0-9_-]+\\.(?:svg|css|js|woff2)$',
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        continue: true,
      },
      {
        src: '^/assets/(?:office|mascot|artwork)-static-[a-f0-9]+\\.svg$',
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        continue: true,
      },
      {
        src: '^/.*\\.(?:txt|sh|ps1)$',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        continue: true,
      },
      {
        src: '^/sitemap\\.xml$',
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        continue: true,
      },
      {
        src: '^/$',
        headers: {
          Link: `<${this.origin}/openapi.json>; rel="service-desc"; type="application/json", <${this.origin}/llms.txt>; rel="describedby"; type="text/plain"`,
        },
        continue: true,
      },
      {
        src: '^/.*$',
        methods: [
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          'OPTIONS',
          'TRACE',
          'CONNECT',
        ],
        dest: '/site',
      },
      {
        src: '^/.*\\.(?:md|mdx)$',
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        continue: true,
      },
    ];
    if (this.kind === 'docs') {
      for (const page of this.docsPages) {
        const route = page.route === '/' ? '/' : page.route.replace(/\/$/, '');
        const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        routes.push({
          src: route === '/' ? '^/$' : `^${escaped}/?$`,
          dest: route === '/' ? '/index.html' : `${route}/index.html`,
        });
      }
    }
    if (this.kind === 'marketing') {
      for (const policy of ['terms', 'privacy'])
        routes.push({
          src: `^/${policy}/?$`,
          status: 308,
          headers: { Location: `/legal/${policy}` },
        });
      routes.push({
        src: '^/openapi\\.json$',
        status: 307,
        headers: { Location: `${docsOrigin}/openapi.json` },
      });
      for (const [route, page] of Object.entries(pages)) {
        const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        routes.push({
          src:
            route === '/'
              ? '^/(?:index\\.html)?$'
              : `^${escaped}(?:/|/index\\.html)?$`,
          dest: '/site',
        });
        if (page.markdown !== null)
          routes.push({
            src: `^${page.markdownPath.replaceAll('.', '\\.')}$`,
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              'X-Robots-Tag': page.noindex ? 'noindex' : 'all',
              Link: `<${page.canonical}>; rel="canonical"`,
            },
            continue: true,
          });
      }
    }
    routes.unshift({ src: '^/404(?:\\.(?:html|json|md))?$', dest: '/site' });
    if (this.kind === 'docs')
      routes.unshift({
        src: '^/\\.well-known/api-catalog$',
        headers: { 'Content-Type': 'application/linkset+json' },
        continue: true,
      });
    routes.push({ handle: 'filesystem' }, { src: '^/.*$', dest: '/site' });
    await writeFile(
      resolve(output, 'config.json'),
      JSON.stringify({ version: 3, routes }, null, 2),
    );
  }

  async build() {
    this.policy = createDiscoveryPolicy(
      JSON.parse(
        await readFile(
          resolve(this.directory, 'discovery.config.json'),
          'utf8',
        ),
      ),
    );
    const pages =
      this.kind === 'marketing'
        ? await this.marketing()
        : await this.documentation();
    await this.package(pages);
    if (this.kind === 'marketing')
      await writeFile(
        resolve(this.directory, '.vercel/output/content-report.json'),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(pages).map(([route, page]) => [
              route,
              this.content.measure(page.html),
            ]),
          ),
          null,
          2,
        ),
      );
  }
}

export const createAgentBuild = (options) => new AgentBuild(options);
