import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { type Connect, defineConfig, type Plugin } from 'vite';

const serveOldPage: Connect.NextHandleFunction = (request, _response, next) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/old') {
    request.url = `/old/index.html${url.search}`;
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
  server: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [
    {
      name: 'klex-old-page-route',
      configureServer(server) {
        server.middlewares.use(serveOldPage);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveOldPage);
      },
    },
    klexInstallerAssets(),
    tailwindcss(),
  ],
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        old: fileURLToPath(new URL('./old/index.html', import.meta.url)),
      },
    },
  },
});
