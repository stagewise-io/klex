import { createFooterMarkup } from '../../new/sections/footer/markup.ts';
import {
  assert,
  MAX_CATALOG_BYTES,
  MAX_RENDERED_BYTES,
  origin,
  PUBLIC_ORIGIN,
  revisionPath,
  validateCatalog,
} from '../legal.ts';
import { renderMarkdown } from './markdown.ts';
import {
  createCatalog,
  type LegalSources,
  type SourceRevision,
} from './node.ts';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );
}

function article(revision: SourceRevision): string {
  const path = revisionPath(revision.policy, revision.revision);
  return `<article data-legal-article data-policy="${escapeHtml(revision.policy)}" data-revision="${revision.revision}" data-effective-date="${revision.effectiveDate}" data-sha256="${revision.sha256}">
<header class="legal-document-header"><h1>${escapeHtml(revision.title)}</h1>
<p class="legal-metadata">Effective <time datetime="${revision.effectiveDate}">${revision.effectiveDate} (UTC)</time><span>Revision ${revision.revision}</span></p>
${revision.changeSummary ? `<p class="legal-summary">${escapeHtml(revision.changeSummary)}</p>` : ''}</header>
<div class="legal-prose">${renderMarkdown(revision.body)}</div>
<section class="legal-source" aria-label="Document source"><a href="${path}.md" download>Download original Markdown</a><p>SHA-256 of the original Markdown</p><code>${revision.sha256}</code></section>
</article>`;
}

function revisionList(sources: LegalSources, policy: string): string {
  const revisions = sources.revisions
    .filter((record) => record.policy === policy)
    .sort((a, b) => b.revision.localeCompare(a.revision));
  return `<section id="legal-fallback" class="legal-fallback" aria-labelledby="revision-list-title"><h2 id="revision-list-title">Published revisions</h2><p>Automatic selection uses JavaScript and your device's UTC clock. Each dated link always opens that exact revision.</p>${revisions.length ? `<ul>${revisions.map((record) => `<li><a href="${revisionPath(policy, record.revision)}">${record.revision}</a> — effective <time datetime="${record.effectiveDate}">${record.effectiveDate}</time> at 00:00 UTC</li>`).join('')}</ul>` : '<p data-empty-revisions>No approved revisions have been published.</p>'}</section>`;
}

function frame(
  sources: LegalSources,
  policy: string,
  label: string,
  revision?: SourceRevision,
): string {
  return `<a class="new-skip-link" href="#legal-main">Skip to policy</a>
<header class="new-header"><a class="new-brand" href="/" aria-label="Klex home"><img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33"><img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33"></a><div id="new-nav"><nav aria-label="Main"><a href="https://docs.klex.bot">Docs</a><a href="https://github.com/stagewise-io/klex">GitHub</a></nav></div></header>
<main id="legal-main" tabindex="-1" class="legal-main" data-policy="${policy}" data-label="${escapeHtml(label)}" data-fixed-revision="${revision?.revision ?? ''}">
<div class="legal-notice"><p id="legal-status" role="status" aria-live="polite">${revision ? 'Dated revision. See published revisions below for effective dates.' : 'Choose a dated revision below, or enable JavaScript for automatic selection.'}</p><button id="legal-retry" type="button" hidden>Retry loading policy</button></div>
<div id="legal-document">${revision ? article(revision) : `<h1>${escapeHtml(label)}</h1><p class="legal-unavailable">${sources.revisions.some((entry) => entry.policy === policy) ? 'The effective revision will load here. Dated revisions remain available below.' : 'This policy is not yet available. No approved revision has been published.'}</p>`}</div>
<nav id="legal-history" class="legal-history" aria-label="Revision history" hidden></nav>
${revisionList(sources, policy)}</main>
${createFooterMarkup({ showCta: false })}`;
}

export function generateArtifacts(
  sources: LegalSources,
  template: string,
  siteOrigin = PUBLIC_ORIGIN,
): Map<string, string | Buffer> {
  origin(siteOrigin);
  assert(
    template.includes('<!-- legal:head -->') &&
      template.includes('<!-- legal:body -->'),
    'Legal HTML template markers are missing',
  );
  const artifacts = new Map<string, string | Buffer>();
  const catalog = validateCatalog(
    createCatalog(sources, siteOrigin),
    siteOrigin,
  );
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
  assert(
    Buffer.byteLength(catalogText) <= MAX_CATALOG_BYTES,
    'Published legal catalog exceeds 2 MiB',
  );
  artifacts.set('legal/policies.json', catalogText);
  for (const type of sources.registry.policies) {
    const documents = sources.revisions.filter(
      (entry) => entry.policy === type.slug,
    );
    const pages: (SourceRevision | undefined)[] = [undefined, ...documents];
    for (const revision of pages) {
      const path = revision
        ? revisionPath(type.slug, revision.revision)
        : `/legal/${type.slug}`;
      const title = revision?.title ?? type.label;
      const head = `<title>${escapeHtml(title)}${revision ? ` — ${revision.revision}` : ''} | Klex</title><meta name="description" content="${escapeHtml(`${title}: effective dates, original source and revision history.`)}"><link rel="canonical" href="${siteOrigin}${path}">${revision || documents.length === 0 ? '<meta name="robots" content="noindex,follow">' : ''}<meta name="legal-origin" content="${siteOrigin}">`;
      const html = template
        .replace('<!-- legal:head -->', head)
        .replace(
          '<!-- legal:body -->',
          frame(sources, type.slug, type.label, revision),
        );
      assert(
        Buffer.byteLength(html) <= MAX_RENDERED_BYTES,
        'Legal HTML exceeds 16 MiB',
      );
      artifacts.set(`${path.slice(1)}/index.html`, html);
      if (revision) artifacts.set(`${path.slice(1)}.md`, revision.bytes);
    }
  }
  return artifacts;
}

export function resolveLegalRequest(
  pathname: string,
  artifacts: Map<string, string | Buffer>,
): string | undefined {
  if (!pathname.startsWith('/legal/') && pathname !== '/legal')
    return undefined;
  const path = pathname.slice(1).replace(/\/$/, '');
  if (artifacts.has(path)) return path;
  if (artifacts.has(`${path}/index.html`)) return `${path}/index.html`;
  return undefined;
}
