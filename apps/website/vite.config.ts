import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { type Connect, createServer, defineConfig, type Plugin } from 'vite';

import { createLegalPlugin } from './src/legal/node/index.ts';
import { staticMascots } from './static-mascot-plugin.ts';

interface MarketingRender {
  /** Supported locales from `src/i18n/i18n.ts`, English included. */
  locales: readonly string[];
  pages: Record<string, string>;
}

async function renderMarketingLocale(locale = 'en'): Promise<MarketingRender> {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('.', import.meta.url)),
    appType: 'custom',
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['@klex/mascot', '@stagewise/ui'] },
    plugins: [staticMascots()],
    build: { assetsInlineLimit: 0 },
  });
  try {
    const { i18n, locales } = await server.ssrLoadModule('/src/i18n/i18n.ts');
    await i18n.changeLanguage(locale);
    const { prerenderLandingPage } = await server.ssrLoadModule(
      '/src/new/prerender.tsx',
    );
    const { resourceMarkup } = await server.ssrLoadModule(
      '/src/new/resources/page-markup.ts',
    );
    const { comparisonMarkup } = await server.ssrLoadModule(
      '/src/new/comparison/page-markup.ts',
    );
    return {
      locales,
      pages: {
        '/index.html': prerenderLandingPage(),
        '/brand/index.html': resourceMarkup(false),
        '/press/index.html': resourceMarkup(true),
        '/compare/rerun/index.html': comparisonMarkup(),
      },
    };
  } finally {
    await server.close();
  }
}

function devMarkdown(): Plugin {
  return {
    name: 'klex-dev-markdown',
    apply: 'serve',
    configureServer(server) {
      let variants = new Map<string, Promise<MarketingRender>>();
      server.watcher.on('change', () => {
        variants = new Map();
      });
      const render = (locale: string) => {
        let rendered = variants.get(locale);
        if (!rendered) {
          const cache = variants;
          rendered = renderMarketingLocale(locale);
          cache.set(locale, rendered);
          rendered.catch(() => cache.delete(locale));
        }
        return rendered;
      };
      server.middlewares.use(async (request, response, next) => {
        // Keep the real host, port and protocol so canonical URLs, Markdown
        // links and Link headers point at the running dev server or tunnel.
        const forwarded = String(request.headers['x-forwarded-proto'] ?? '')
          .split(',')[0]
          ?.trim();
        const protocol =
          forwarded === 'https' || forwarded === 'http'
            ? forwarded
            : 'encrypted' in request.socket && request.socket.encrypted
              ? 'https'
              : 'http';
        const url = new URL(
          request.url ?? '/',
          `${protocol}://${request.headers.host ?? 'localhost'}`,
        );
        const route =
          url.pathname.replace(/\/index\.html$/, '/').replace(/\/$/, '') || '/';
        const markdownRoute =
          route === '/index.md' ? '/' : route.replace(/\.md$/, '');
        if (
          !['/', '/brand', '/press', '/compare/rerun'].includes(markdownRoute)
        )
          return next();
        try {
          const { createAgentSite } = await import(
            '../../scripts/agent-site/runtime.mjs'
          );
          const negotiation = createAgentSite({
            origin: url.origin,
            pages: {},
            errorHtml: '',
          });
          const explicit = route.endsWith('.md');
          if (
            !explicit &&
            negotiation.quality(
              String(request.headers.accept ?? '*/*'),
              'text/markdown',
            ) <=
              negotiation.quality(
                String(request.headers.accept ?? '*/*'),
                'text/html',
              )
          )
            return next();
          const { createDiscoveryPolicy } = await import(
            '../../scripts/agent-site/policy.mjs'
          );
          const policy = createDiscoveryPolicy(
            JSON.parse(
              await readFile(
                new URL('./discovery.config.json', import.meta.url),
                'utf8',
              ),
            ),
          );
          if (!policy.includes('markdown', markdownRoute)) return next();
          const { locales } = await render('en');
          const languages = Object.fromEntries(
            locales.map((locale) => [locale, true]),
          );
          const locale = negotiation.language(request, languages);
          const markup = (await render(locale)).pages[
            markdownRoute === '/'
              ? '/index.html'
              : `${markdownRoute}/index.html`
          ];
          const { createSiteContent } = await import(
            '../../scripts/agent-site/content.mjs'
          );
          const markdown = createSiteContent().markdown(
            markup,
            `${url.origin}${markdownRoute}`,
          );
          const page = {
            html: markup,
            markdown,
            markdownLocales: { [locale]: markdown, en: markdown },
            canonical: `${url.origin}${markdownRoute}`,
            markdownPath:
              markdownRoute === '/' ? '/index.md' : `${markdownRoute}.md`,
            noindex: markdownRoute !== '/',
          };
          const handler = createAgentSite({
            origin: url.origin,
            pages: { [markdownRoute]: page },
            errorHtml: '',
          });
          handler.handle(request, response);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function prerenderPages(): Plugin {
  let english: Promise<MarketingRender> | undefined;
  return {
    name: 'klex-prerender-pages',
    apply: 'build',
    async generateBundle() {
      english ??= renderMarketingLocale();
      const { locales } = await english;
      const localized: Record<string, Record<string, string>> = {};
      for (const locale of locales) {
        if (locale === 'en') continue;
        localized[locale] = (await renderMarketingLocale(locale)).pages;
      }
      this.emitFile({
        type: 'asset',
        fileName: '__localized-markup.json',
        source: JSON.stringify(localized),
      });
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, context) {
        if (context.path === '/legal/index.html') return html;
        english ??= renderMarketingLocale();
        const markup = (await english).pages[context.path];
        if (!markup)
          throw new Error(`No prerendered markup for ${context.path}`);
        const rendered = html.replace(
          '<div id="app"></div>',
          `<div id="app">${markup}</div>`,
        );
        return context.path === '/index.html'
          ? rendered
          : rendered.replace('<body>', '<body class="resource-page">');
      },
    },
  };
}

const servePageRoutes: Connect.NextHandleFunction = (
  request,
  response,
  next,
) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/$/, '');
  if (['/terms', '/privacy'].includes(route)) {
    response.writeHead(308, { Location: `/legal${route}` });
    response.end();
    return;
  }
  if (['/brand', '/press', '/compare/rerun'].includes(route)) {
    request.url = `${route}/index.html${url.search}`;
  }
  next();
};

const installerSources = {
  '/install.ps1': fileURLToPath(new URL('../../install.ps1', import.meta.url)),
  '/install.sh': fileURLToPath(new URL('../../install.sh', import.meta.url)),
} as const;

function klexInstallerAssets(): Plugin {
  return {
    name: 'klex-installer-assets',
    async buildStart() {
      for (const [publicPath, sourcePath] of Object.entries(installerSources)) {
        this.emitFile({
          type: 'asset',
          fileName: publicPath.slice(1),
          source: await readFile(sourcePath),
        });
      }
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname;
        const sourcePath =
          installerSources[pathname as keyof typeof installerSources];

        if (sourcePath === undefined) {
          next();
          return;
        }

        try {
          const source = await readFile(sourcePath);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(request.method === 'HEAD' ? undefined : source);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  appType: 'mpa',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api/cloud-status': {
        target: 'https://status.klex.bot',
        changeOrigin: true,
        rewrite: () => '/api/v1/summary',
      },
    },
  },
  plugins: [
    staticMascots(),
    devMarkdown(),
    prerenderPages(),
    {
      name: 'klex-page-routes',
      configureServer(server) {
        server.middlewares.use(servePageRoutes);
      },
      configurePreviewServer(server) {
        server.middlewares.use(servePageRoutes);
      },
    },
    createLegalPlugin({
      contentRoot: fileURLToPath(new URL('./content/legal', import.meta.url)),
      templatePath: fileURLToPath(
        new URL('./legal/index.html', import.meta.url),
      ),
    }),
    klexInstallerAssets(),
    tailwindcss(),
  ],
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        legal: fileURLToPath(new URL('./legal/index.html', import.meta.url)),
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        brand: fileURLToPath(new URL('./brand/index.html', import.meta.url)),
        press: fileURLToPath(new URL('./press/index.html', import.meta.url)),
        rerun: fileURLToPath(
          new URL('./compare/rerun/index.html', import.meta.url),
        ),
      },
    },
  },
});
