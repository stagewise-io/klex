import { readFileSync } from 'node:fs';

import { createCloudStatus } from './cloud-status.mjs';

/** Dependency-free handler, copied with its manifest into each Vercel function. */
class AgentSite {
  constructor(manifest) {
    this.manifest = manifest;
  }

  quality(accept, type) {
    const [major] = type.split('/');
    let result = { specificity: -1, quality: 0 };
    for (const entry of accept.toLowerCase().split(',')) {
      const [media, ...parameters] = entry
        .trim()
        .split(';')
        .map((value) => value.trim());
      const specificity =
        media === type
          ? 2
          : media === `${major}/*`
            ? 1
            : media === '*/*'
              ? 0
              : -1;
      if (specificity < 0) continue;
      const q = parameters
        .map((value) => value.trim())
        .find((value) => value.startsWith('q='));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      const validQuality =
        Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
      if (
        specificity > result.specificity ||
        (specificity === result.specificity && validQuality > result.quality)
      )
        result = { specificity, quality: validQuality };
    }
    return result.quality;
  }

  language(request, available) {
    const cookie = String(request.headers?.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('klex-language='))
      ?.slice('klex-language='.length);
    if (cookie && Object.hasOwn(available, cookie)) return cookie;
    const preferences = String(request.headers?.['accept-language'] ?? '')
      .split(',')
      .map((entry, index) => {
        const [tag, ...parameters] = entry.trim().toLowerCase().split(';');
        const parameter = parameters
          .map((value) => value.trim())
          .find((value) => value.startsWith('q='));
        const quality =
          parameter === undefined ? 1 : Number(parameter.slice(2));
        return {
          language: tag.split('-')[0],
          quality:
            Number.isFinite(quality) && quality >= 0 && quality <= 1
              ? quality
              : 0,
          index,
        };
      })
      .filter((value) => value.quality > 0)
      .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const { language } of preferences)
      if (Object.hasOwn(available, language)) return language;
    return 'en';
  }

  response(request) {
    const url = new URL(request.url, this.manifest.origin);
    const path = url.pathname;
    const normalized =
      path.replace(/\/index\.html$/, '/').replace(/\/$/, '') || '/';
    const explicitMarkdown = Object.values(this.manifest.pages).find(
      (page) => page.markdown !== null && page.markdownPath === path,
    );
    const page =
      explicitMarkdown ??
      (Object.hasOwn(this.manifest.pages, normalized)
        ? this.manifest.pages[normalized]
        : undefined);
    const method = request.method ?? 'GET';
    const accept = String(request.headers?.accept ?? '*/*');
    const api = normalized === '/api' || normalized.startsWith('/api/');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
      Vary: 'Accept',
      'X-Content-Type-Options': 'nosniff',
      Link: `<${this.manifest.origin}/agent-readability.json>; rel="describedby"; type="application/json", <${this.manifest.origin}/llms.txt>; rel="alternate"; type="text/plain"`,
    };
    let status = 200;
    let body;
    let error;
    if (!['GET', 'HEAD'].includes(method)) {
      status = 405;
      headers.Allow = 'GET, HEAD';
      error = {
        code: 'METHOD_NOT_ALLOWED',
        message: 'This public documentation site is read-only.',
        suggestion:
          'Retry with GET or HEAD. Bot administration requires your own authenticated Klex admin endpoint.',
      };
    } else if (!page) {
      status = 404;
      error = api
        ? {
            code: 'NOT_FOUND',
            message: 'Documentation API endpoint or page not found.',
            suggestion:
              'List available documentation pages at https://docs.klex.bot/api/docs/pages.json, then use the returned paths. See https://docs.klex.bot/openapi.json for supported operations.',
          }
        : {
            code: 'NOT_FOUND',
            message: 'This page could not be found.',
            suggestion:
              'Start at the homepage, consult /llms.txt, or search the documentation at https://docs.klex.bot.',
          };
    }
    if (error) {
      const json =
        api ||
        normalized.endsWith('.json') ||
        Math.max(
          this.quality(accept, 'application/json'),
          this.quality(accept, 'application/problem+json'),
        ) > this.quality(accept, 'text/html');
      const markdown =
        !json &&
        (normalized.endsWith('.md') ||
          this.quality(accept, 'text/markdown') >
            this.quality(accept, 'text/html'));
      headers['X-Robots-Tag'] = 'noindex';
      if (json) {
        headers['Content-Type'] = 'application/problem+json; charset=utf-8';
        body = JSON.stringify({
          type: 'about:blank',
          title: status === 404 ? 'Not Found' : 'Method Not Allowed',
          status,
          code: api && status === 404 ? 'PAGE_NOT_FOUND' : error.code,
          detail: error.message,
          resolution: error.suggestion,
          links: [
            {
              href: 'https://docs.klex.bot/api/docs/pages.json',
              label: 'List documentation pages',
            },
            { href: `${this.manifest.origin}/llms.txt`, label: 'Agent guide' },
          ],
        });
      } else if (markdown) {
        headers['Content-Type'] = 'text/markdown; charset=utf-8';
        body = `# ${status}: ${error.message}\n\n${error.suggestion}\n\n- [Homepage](${this.manifest.origin}/)\n- [Agent guide](${this.manifest.origin}/llms.txt)\n- [Documentation](https://docs.klex.bot/)\n`;
      } else {
        body = this.manifest.errorHtml
          .replaceAll('STATUS_PLACEHOLDER', String(status))
          .replaceAll('MESSAGE_PLACEHOLDER', error.message)
          .replaceAll('SUGGESTION_PLACEHOLDER', error.suggestion);
      }
    } else {
      const markdown =
        page.markdown === null ? 0 : this.quality(accept, 'text/markdown');
      const html = this.quality(accept, 'text/html');
      // Ties (including browser */*) keep HTML; explicit q=0 excludes a representation.
      if (markdown === 0 && html === 0) {
        status = 406;
        headers['Content-Type'] = 'application/json; charset=utf-8';
        body = JSON.stringify({
          error: {
            code: 'NOT_ACCEPTABLE',
            message: 'No acceptable page representation.',
            suggestion:
              'Request text/html or text/markdown, or use the explicit .md URL.',
          },
        });
      } else {
        const useMarkdown = Boolean(explicitMarkdown) || markdown > html;
        headers['Content-Type'] = useMarkdown
          ? 'text/markdown; charset=utf-8'
          : 'text/html; charset=utf-8';
        headers.Link += `, <${page.canonical}>; rel="canonical"${page.markdown === null ? '' : `, <${new URL(page.markdownPath, this.manifest.origin).href}>; rel="alternate"; type="text/markdown"`}, <https://docs.klex.bot/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"`;
        if (page.noindex) headers['X-Robots-Tag'] = 'noindex';
        if (useMarkdown && page.markdownLocales) {
          const language = this.language(request, page.markdownLocales);
          headers.Vary = 'Accept, Accept-Language, Cookie';
          headers['Content-Language'] = language;
          body = page.markdownLocales[language];
        } else body = useMarkdown ? page.markdown : page.html;
      }
    }
    headers['Content-Length'] = String(Buffer.byteLength(body));
    return { status, headers, body: method === 'HEAD' ? '' : body };
  }

  handle(request, response) {
    const result = this.response(request);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  }
}

export const createAgentSite = (manifest) => new AgentSite(manifest);

// Only loaded when this module is the deployed function entrypoint.
let deployedSite;
const cloudStatus = createCloudStatus();
export default async function handler(request, response) {
  if (
    new URL(request.url, 'https://www.klex.bot').pathname ===
      '/api/cloud-status' &&
    ['GET', 'HEAD'].includes(request.method)
  ) {
    const result = await cloudStatus.response();
    response.writeHead(result.status, result.headers);
    response.end(request.method === 'HEAD' ? undefined : result.body);
    return;
  }
  deployedSite ??= createAgentSite(
    JSON.parse(
      readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'),
    ),
  );
  deployedSite.handle(request, response);
}
