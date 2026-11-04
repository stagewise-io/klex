import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
const directory = fileURLToPath(
  new URL(
    kind === 'docs'
      ? '../../apps/docs/.vercel/output'
      : '../../apps/website/.vercel/output',
    import.meta.url,
  ),
);
let manifest = JSON.parse(
  await readFile(
    resolve(directory, 'functions/site.func/manifest.json'),
    'utf8',
  ),
);
let configuration = JSON.parse(
  await readFile(resolve(directory, 'config.json'), 'utf8'),
);
let { default: handler } = await import(
  new URL(`file://${resolve(directory, 'functions/site.func/runtime.mjs')}`)
);
const site = { handle: handler };
let manifestVersion = (
  await stat(resolve(directory, 'functions/site.func/manifest.json'))
).mtimeMs;
const mime = {
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.sh': 'text/plain',
  '.ps1': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (request, response) => {
  try {
    const version = (
      await stat(resolve(directory, 'functions/site.func/manifest.json'))
    ).mtimeMs;
    if (version !== manifestVersion) {
      manifest = JSON.parse(
        await readFile(
          resolve(directory, 'functions/site.func/manifest.json'),
          'utf8',
        ),
      );
      configuration = JSON.parse(
        await readFile(resolve(directory, 'config.json'), 'utf8'),
      );
      ({ default: handler } = await import(
        new URL(
          `file://${resolve(directory, 'functions/site.func/runtime.mjs')}?build=${version}`,
        )
      ));
      site.handle = handler;
      manifestVersion = version;
    }
    let pathname = new URL(request.url, manifest.origin).pathname;
    for (const route of configuration.routes) {
      if (route.handle === 'filesystem') {
        const base = resolve(directory, 'static');
        let path = resolve(base, `.${decodeURIComponent(pathname)}`);
        if (path !== base && !path.startsWith(`${base}${sep}`)) break;
        try {
          if ((await stat(path)).isDirectory())
            path = resolve(path, 'index.html');
          const body = await readFile(path);
          if (!['GET', 'HEAD'].includes(request.method)) break;
          response.writeHead(200, {
            'Content-Type': `${mime[extname(path)] ?? 'application/octet-stream'}${['.md', '.html', '.txt', '.json', '.xml'].includes(extname(path)) ? '; charset=utf-8' : ''}`,
            'Content-Length': body.length,
            'X-Content-Type-Options': 'nosniff',
            ...response.getHeaders(),
          });
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
        continue;
      }
      if (
        !new RegExp(route.src).test(pathname) ||
        (route.methods && !route.methods.includes(request.method))
      )
        continue;
      for (const [name, value] of Object.entries(route.headers ?? {}))
        response.setHeader(name, value);
      if (route.status) {
        response.writeHead(route.status);
        response.end();
        return;
      }
      if (route.continue) continue;
      if (route.dest === '/site') {
        await site.handle(request, response);
        return;
      }
      if (route.dest) pathname = route.dest;
    }
    await site.handle(request, response);
  } catch {
    response.writeHead(500, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    });
    response.end('Preview failed. Rebuild the site and retry.');
  }
});
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 4173 : Number(process.argv[portIndex + 1]);
server.listen(port, '127.0.0.1', () =>
  console.log(`Local: http://127.0.0.1:${port}/`),
);
