import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Connect, Plugin } from 'vite';

import { PUBLIC_ORIGIN, validateCatalog } from '../legal.ts';
import { createLegalSource, type LegalSources } from './node.ts';
import { generateArtifacts, resolveLegalRequest } from './render.ts';

export function createLegalPlugin(options: {
  contentRoot: string;
  templatePath: string;
  siteOrigin?: string;
}): Plugin {
  const siteOrigin = options.siteOrigin ?? PUBLIC_ORIGIN;
  const source = createLegalSource(options.contentRoot);
  let sources: LegalSources;
  let outputDirectory = '';
  return {
    name: 'klex-legal-pages',
    enforce: 'post',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    async buildStart() {
      sources = await source.load();
      for (const entry of sources.revisions)
        this.addWatchFile(resolve(options.contentRoot, entry.source));
      this.addWatchFile(resolve(options.contentRoot, 'policies.json'));
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const template = bundle['legal/index.html'];
        if (template?.type !== 'asset')
          throw new Error('Vite did not emit the legal HTML template');
        const artifacts = generateArtifacts(
          sources,
          String(template.source),
          siteOrigin,
        );
        delete bundle['legal/index.html'];
        for (const [fileName, value] of artifacts)
          this.emitFile({ type: 'asset', fileName, source: value });
      },
    },
    configureServer(server) {
      server.watcher.add(options.contentRoot);
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/legal' && !url.pathname.startsWith('/legal/'))
          return next();
        try {
          const artifacts = generateArtifacts(
            await source.load(),
            await readFile(options.templatePath, 'utf8'),
            siteOrigin,
          );
          const file = resolveLegalRequest(url.pathname, artifacts);
          if (!file) {
            response.statusCode = 404;
            response.end('Legal document not found');
            return;
          }
          let body = artifacts.get(file) ?? '';
          if (file.endsWith('.html'))
            body = await server.transformIndexHtml(url.pathname, String(body));
          send(request, response, file, body);
        } catch (error) {
          next(error);
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname;
        if (pathname !== '/legal' && !pathname.startsWith('/legal/'))
          return next();
        try {
          const catalog = validateCatalog(
            JSON.parse(
              await readFile(
                resolve(outputDirectory, 'legal/policies.json'),
                'utf8',
              ),
            ),
            siteOrigin,
          );
          const artifacts = new Map<string, string | Buffer>([
            ['legal/policies.json', ''],
          ]);
          for (const [policy, entries] of Object.entries(catalog.policies)) {
            artifacts.set(`legal/${policy}/index.html`, '');
            for (const entry of entries) {
              artifacts.set(`legal/${policy}/${entry.revision}/index.html`, '');
              artifacts.set(`legal/${policy}/${entry.revision}.md`, '');
            }
          }
          const file = resolveLegalRequest(pathname, artifacts);
          if (!file) {
            response.statusCode = 404;
            response.end('Legal document not found');
            return;
          }
          send(
            request,
            response,
            file,
            await readFile(resolve(outputDirectory, file)),
          );
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function send(
  request: Connect.IncomingMessage,
  response: import('node:http').ServerResponse,
  file: string,
  body: string | Buffer,
): void {
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD');
    response.end();
    return;
  }
  response.setHeader(
    'Content-Type',
    file.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : file.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : 'text/html; charset=utf-8',
  );
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(request.method === 'HEAD' ? undefined : body);
}
