import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { type Connect, createServer, defineConfig, type Plugin } from 'vite';

import { createLegalPlugin } from './src/legal/node/index.ts';

function prerenderPages(): Plugin {
  let pages: Promise<Record<string, string>> | undefined;
  return {
    name: 'klex-prerender-pages',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      async handler(html, context) {
        if (context.path === '/legal/index.html') return html;
        pages ??= (async () => {
          const server = await createServer({
            configFile: false,
            root: fileURLToPath(new URL('.', import.meta.url)),
            appType: 'custom',
            server: {
              middlewareMode: true,
              hmr: false,
              ws: false,
              watch: null,
            },
            optimizeDeps: { noDiscovery: true, include: [] },
            ssr: { noExternal: ['@klex/mascot', '@stagewise/ui'] },
          });
          try {
            const { prerenderLandingPage } = await server.ssrLoadModule(
              '/src/new/prerender.tsx',
            );
            const pageMarkup = prerenderLandingPage();
            const { resourceMarkup } = await server.ssrLoadModule(
              '/src/new/resources/page-markup.ts',
            );
            return {
              '/index.html': pageMarkup,
              '/brand/index.html': resourceMarkup(false),
              '/press/index.html': resourceMarkup(true),
            };
          } finally {
            await server.close();
          }
        })();
        const markup = (await pages)[context.path];
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
  _response,
  next,
) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/$/, '');
  if (['/brand', '/press'].includes(route)) {
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
  server: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [
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
    rolldownOptions: {
      input: {
        legal: fileURLToPath(new URL('./legal/index.html', import.meta.url)),
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        brand: fileURLToPath(new URL('./brand/index.html', import.meta.url)),
        press: fileURLToPath(new URL('./press/index.html', import.meta.url)),
      },
    },
  },
});
