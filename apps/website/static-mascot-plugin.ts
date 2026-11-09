import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createServer, type Plugin } from 'vite';

export function staticMascots(): Plugin {
  let assets: Promise<Record<string, { src: string; svg: string }>> | undefined;
  const loadAssets = () =>
    (assets ??= (async () => {
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('.', import.meta.url)),
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
        ssr: { noExternal: ['@klex/mascot', '@stagewise/ui'] },
      });
      try {
        const { renderStaticMascots } = await server.ssrLoadModule(
          '/src/new/static-mascot/artwork.tsx',
        );
        const result: Record<string, { src: string; svg: string }> = {};
        for (const [name, markup] of Object.entries(
          renderStaticMascots() as Record<string, string>,
        )) {
          const match =
            [...markup.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].find((match) =>
              match[0].includes('role="img"'),
            ) ?? markup.match(/<svg\b[\s\S]*?<\/svg>/);
          if (!match) throw new Error(`No SVG for static mascot ${name}`);
          const shadow = !match[0].includes('role="img"')
            ? ''
            : ([...markup.matchAll(/<svg\b[\s\S]*?<\/svg>/g)]
                .find((item) => item[0].includes('aria-hidden="true"'))?.[0]
                .replace(/^<svg[^>]*>/, '')
                .replace(/<\/svg>$/, '') ?? '');
          const svg = match[0]
            .replace(/(<svg[^>]*>)/, `$1${shadow}`)
            .replace(/\sxmlns="[^"]*"/g, '')
            .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
            .replace(/class="[^"]*"/g, '')
            .replace(/\sdata-pupil(?=[\s/>])/g, ' data-pupil=""')
            .replace(/<svg ([^>]+)>/, '<svg $1 style="overflow:visible">')
            .replace(
              /(<svg[^>]*>)([\s\S]*)(<\/svg>)/,
              '$1<g id="artwork">$2</g>$3',
            );
          const hash = createHash('sha256')
            .update(svg)
            .digest('hex')
            .slice(0, 16);
          result[name] = {
            src: `/assets/mascot-static-${hash}.svg`,
            svg,
          };
        }
        return result;
      } finally {
        await server.close();
      }
    })());
  let building = false;
  return {
    configResolved(config) {
      building = config.command === 'build';
    },
    name: 'klex-static-mascots',
    resolveId(id) {
      if (id === 'virtual:klex-static-mascots') return '\0klex-static-mascots';
    },
    async load(id) {
      if (id !== '\0klex-static-mascots') return;
      const entries = await loadAssets();
      return `export default ${JSON.stringify(Object.fromEntries(Object.entries(entries).map(([name, asset]) => [name, { src: asset.src }])))};`;
    },
    async buildStart() {
      if (!building) return;
      for (const asset of Object.values(await loadAssets()))
        this.emitFile({
          type: 'asset',
          fileName: asset.src.slice(1),
          source: asset.svg,
        });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith('/assets/mascot-static-')) return next();
        try {
          const asset = Object.values(await loadAssets()).find(
            (asset) => asset.src === path,
          );
          if (!asset) return next();
          response.setHeader('Content-Type', 'image/svg+xml');
          response.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
          response.end(request.method === 'HEAD' ? undefined : asset.svg);
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}
