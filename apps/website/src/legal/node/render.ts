import { createFooterMarkup } from '../../new/sections/footer/markup.ts';
import {
  assert,
  MAX_CATALOG_BYTES,
  MAX_RENDERED_BYTES,
  origin,
  PUBLIC_ORIGIN,
  revisionPath,
  revisionState,
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
  return `<article data-legal-article data-policy="${escapeHtml(revision.policy)}" data-revision="${revision.revision}" data-effective-date="${revision.effectiveDate}" data-sha256="${revision.sha256}">
<header class="legal-document-header"><h1>${escapeHtml(revision.title)}</h1>
<p class="legal-metadata">Effective <time datetime="${revision.effectiveDate}">${revision.effectiveDate}</time></p>
${revision.changeSummary ? `<p class="legal-summary">${escapeHtml(revision.changeSummary)}</p>` : ''}</header>
<div class="legal-prose">${renderMarkdown(revision.body)}</div>
</article>`;
}

function revisionList(sources: LegalSources, policy: string): string {
  const revisions = sources.revisions
    .filter((record) => record.policy === policy)
    .sort((a, b) => b.revision.localeCompare(a.revision));
  return `<section id="legal-fallback" class="legal-fallback" aria-labelledby="revision-list-title"><h2 id="revision-list-title">Published revisions</h2><p>Each dated link opens that version of the policy.</p>${revisions.length ? `<ul>${revisions.map((record) => `<li><a href="${revisionPath(policy, record.revision)}">${record.revision}</a> — effective <time datetime="${record.effectiveDate}">${record.effectiveDate}</time></li>`).join('')}</ul>` : '<p data-empty-revisions>No approved revisions have been published.</p>'}</section>`;
}

function frame(
  sources: LegalSources,
  policy: string,
  label: string,
  revision?: SourceRevision,
  now = new Date(),
): string {
  const documents = sources.revisions
    .filter((entry) => entry.policy === policy)
    .sort((a, b) => b.revision.localeCompare(a.revision));
  const current = documents.find(
    (entry) => entry.effectiveDate <= now.toISOString().slice(0, 10),
  );
  const displayed = revision ?? current;
  const versions = policy
    ? createCatalog({ ...sources, revisions: documents }).policies[policy]
    : [];
  const selected = versions.find(
    (entry) => entry.revision === displayed?.revision,
  );
  const state = selected ? revisionState(versions, selected, now) : undefined;
  const notice =
    state?.status === 'historical'
      ? 'Previous version. This document is no longer current.'
      : state?.status === 'upcoming'
        ? `Upcoming version. Effective ${displayed?.effectiveDate}.`
        : '';
  const history = state
    ? `${state.status !== 'current' && current ? `<p><a href="/legal/${policy}">Read the current policy</a></p>` : ''}${state.earlier.length ? `<h2>Previous versions</h2><ul>${state.earlier.map((entry) => `<li><a href="${revisionPath(policy, entry.revision)}">Effective ${entry.effectiveDate}</a></li>`).join('')}</ul>` : ''}`
    : '';
  return `<a class="new-skip-link" href="#legal-main">Skip to policy</a>
<header class="new-header"><a class="new-brand" href="/" aria-label="Klex home"><img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33"><img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33"></a><div id="new-nav"><nav aria-label="Main"><a href="https://docs.klex.bot">Docs</a><a href="https://github.com/stagewise-io/klex">GitHub</a></nav></div></header>
<main id="legal-main" tabindex="-1" class="legal-main" data-policy="${policy}" data-label="${escapeHtml(label)}" data-fixed-revision="${revision?.revision ?? ''}">
<p class="legal-back"><a href="/legal"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>Legal Center</a></p>
${notice ? `<div class="legal-notice"><p>${notice}</p></div>` : ''}
<div id="legal-document">${displayed ? article(displayed) : `<h1>${escapeHtml(label)}</h1><p class="legal-unavailable">${documents.length ? 'No policy is effective yet. Upcoming versions are listed below.' : 'This policy is not yet available.'}</p>`}</div>
${history ? `<nav id="legal-history" class="legal-history" aria-label="Revision history" data-markdown="include">${history}</nav>` : ''}
${displayed ? '' : revisionList(sources, policy)}</main>
${createFooterMarkup({ showCta: false })}`;
}

export function generateArtifacts(
  sources: LegalSources,
  template: string,
  siteOrigin = PUBLIC_ORIGIN,
  now = new Date(),
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
  const centerBody = frame(sources, '', 'Legal Center');
  const centerMain = `<main id="legal-center" tabindex="-1" class="legal-main"><header class="legal-document-header"><h1>Legal Center</h1></header><nav aria-label="Legal documents" data-markdown="include"><ul class="legal-center-list">${sources.registry.policies.map((type) => `<li><a href="/legal/${escapeHtml(type.slug)}">${escapeHtml(type.label)}<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></a></li>`).join('')}</ul></nav></main>`;
  artifacts.set(
    'legal/index.html',
    template
      .replace(
        '<!-- legal:head -->',
        () =>
          `<title>Legal Center | Klex</title><meta name="description" content="Terms and policies for Klex Cloud and the Klex website."><link rel="canonical" href="${siteOrigin}/legal">`,
      )
      .replace('<!-- legal:body -->', () =>
        centerBody
          .replace(/<main\b[\s\S]*?<\/main>/, () => centerMain)
          .replace('href="#legal-main"', 'href="#legal-center"'),
      ),
  );
  for (const type of sources.registry.policies) {
    const documents = sources.revisions.filter(
      (entry) => entry.policy === type.slug,
    );
    const pages: (SourceRevision | undefined)[] = [undefined, ...documents];
    for (const revision of pages) {
      const path = revision
        ? revisionPath(type.slug, revision.revision)
        : `/legal/${type.slug}`;
      const effective = documents
        .filter(
          (entry) => entry.effectiveDate <= now.toISOString().slice(0, 10),
        )
        .sort((a, b) => b.revision.localeCompare(a.revision))[0];
      const title = (revision ?? effective)?.title ?? type.label;
      const head = `<title>${escapeHtml(title)}${revision ? ` — ${revision.revision}` : ''} | Klex</title><meta name="description" content="${escapeHtml(`${title}: effective dates, original source and revision history.`)}"><link rel="canonical" href="${siteOrigin}${path}">${revision || documents.length === 0 ? '<meta name="robots" content="noindex,follow">' : ''}<meta name="legal-origin" content="${siteOrigin}">`;
      const html = template
        .replace('<!-- legal:head -->', () => head)
        .replace('<!-- legal:body -->', () =>
          frame(sources, type.slug, type.label, revision, now),
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
