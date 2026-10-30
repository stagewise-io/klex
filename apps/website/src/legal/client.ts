import {
  assert,
  boundaryDelay,
  MAX_CATALOG_BYTES,
  MAX_RENDERED_BYTES,
  PUBLIC_ORIGIN,
  type Revision,
  revisionPath,
  revisionState,
  safeLink,
  selectEffective,
  validateCatalog,
} from './legal.ts';

const tags = new Set([
  'ARTICLE',
  'HEADER',
  'SECTION',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'P',
  'TIME',
  'SPAN',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'CODE',
  'EM',
  'STRONG',
  'S',
  'HR',
  'BR',
  'A',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
]);
const classes = new Set([
  'legal-document-header',
  'legal-metadata',
  'legal-summary',
  'legal-prose',
  'legal-source',
]);

export function importArticle(
  html: string,
  policy: string,
  revision: Revision,
  document: Document,
): HTMLElement {
  const Parser = document.defaultView?.DOMParser;
  assert(Parser, 'DOM parser unavailable');
  const parsed = new Parser().parseFromString(html, 'text/html');
  const articles = parsed.querySelectorAll('article[data-legal-article]');
  assert(articles.length === 1, 'Expected exactly one legal article');
  const source = articles[0] as HTMLElement;
  assert(
    source.dataset.policy === policy &&
      source.dataset.revision === revision.revision &&
      source.dataset.effectiveDate === revision.effectiveDate &&
      source.dataset.sha256 === revision.sha256,
    'Catalog/article identity mismatch',
  );
  assert(
    source.querySelectorAll('h1').length === 1,
    'Expected a single policy title',
  );
  const copy = (node: Node): Node => {
    if (node.nodeType === 3)
      return document.createTextNode(node.textContent ?? '');
    assert(node.nodeType === 1, 'Unexpected article node');
    const input = node as HTMLElement;
    assert(tags.has(input.tagName), `Unsafe article element: ${input.tagName}`);
    const output = document.createElement(input.tagName.toLowerCase());
    if (input === source) {
      output.setAttribute('data-legal-article', '');
      output.dataset.policy = policy;
      output.dataset.revision = revision.revision;
      output.dataset.effectiveDate = revision.effectiveDate;
      output.dataset.sha256 = revision.sha256;
    }
    for (const name of (input.getAttribute('class') ?? '').split(/\s+/))
      if (classes.has(name)) output.classList.add(name);
    if (
      input.tagName === 'SECTION' &&
      output.classList.contains('legal-source')
    )
      output.setAttribute('aria-label', 'Document source');
    const id = input.getAttribute('id');
    if (id && /^section-[a-z0-9-]+$/.test(id) && /^H[2-6]$/.test(input.tagName))
      output.id = id;
    if (
      input.tagName === 'TIME' &&
      input.getAttribute('datetime') === revision.effectiveDate
    )
      output.setAttribute('datetime', revision.effectiveDate);
    if (
      input.tagName === 'OL' &&
      /^\d{1,6}$/.test(input.getAttribute('start') ?? '')
    )
      output.setAttribute('start', input.getAttribute('start') ?? '1');
    if (input.tagName === 'A') {
      const href = input.getAttribute('href') ?? '';
      assert(safeLink(href), 'Unsafe article link');
      output.setAttribute('href', href);
      if (href === `${revisionPath(policy, revision.revision)}.md`)
        output.setAttribute('download', '');
    }
    for (const child of input.childNodes) output.append(copy(child));
    return output;
  };
  return copy(source) as HTMLElement;
}

export async function boundedText(
  response: Response,
  max: number,
): Promise<string> {
  const length = response.headers.get('content-length');
  assert(
    length === null ||
      (Number.isFinite(Number(length)) && Number(length) <= max),
    'Response too large',
  );
  const reader = response.body?.getReader();
  assert(reader, 'Missing response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= max, 'Response too large');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export interface LegalPage {
  start(): Promise<void>;
  refresh(initial?: boolean): Promise<void>;
  close(): void;
}

export interface LegalPageDependencies {
  document: Document;
  window: Window;
  fetch: typeof fetch;
  now?: () => Date;
}

class LegalPageModule implements LegalPage {
  private deps: LegalPageDependencies;
  private started = false;
  private generation = 0;
  private request?: AbortController;
  private timer?: number;
  private deadline?: number;
  private revisions: Revision[] = [];
  private policy = '';
  private fixed = '';
  private label = '';
  private catalogOrigin = PUBLIC_ORIGIN;
  private documentHost!: HTMLElement;
  private status!: HTMLElement;
  private fallback!: HTMLElement;
  private history!: HTMLElement;
  private retry!: HTMLButtonElement;

  constructor(deps: LegalPageDependencies) {
    this.deps = deps;
  }
  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
  private onFocus = () => {
    if (this.deps.document.visibilityState !== 'hidden') void this.refresh();
  };
  private onRetry = () => {
    void this.refresh();
  };

  async start(): Promise<void> {
    if (this.started) return;
    const { document, window } = this.deps;
    const main = document.getElementById('legal-main');
    assert(main, 'Legal page root missing');
    this.policy = main.dataset.policy ?? '';
    this.fixed = main.dataset.fixedRevision ?? '';
    this.label = main.dataset.label ?? this.policy;
    this.catalogOrigin =
      document.querySelector<HTMLMetaElement>('meta[name="legal-origin"]')
        ?.content ?? PUBLIC_ORIGIN;
    const element = (id: string) => {
      const value = document.getElementById(id);
      assert(value, `Missing ${id}`);
      return value;
    };
    this.documentHost = element('legal-document');
    this.status = element('legal-status');
    this.fallback = element('legal-fallback');
    this.history = element('legal-history');
    this.retry = element('legal-retry') as HTMLButtonElement;
    this.started = true;
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('pageshow', this.onFocus);
    document.addEventListener('visibilitychange', this.onFocus);
    this.retry.addEventListener('click', this.onRetry);
    await this.refresh(true);
  }

  async refresh(initial = false): Promise<void> {
    if (!this.started) return;
    const generation = ++this.generation;
    this.request?.abort();
    this.request = new AbortController();
    const signal = this.request.signal;
    const { document, window } = this.deps;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.deadline);
    // Bound slow/stalled responses as well as payload sizes.
    const timeout = window.setTimeout(
      () => this.request?.signal === signal && this.request.abort(),
      15000,
    );
    this.deadline = timeout;
    this.documentHost.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Checking effective policy…';
    this.history.hidden = true;
    try {
      const catalog = validateCatalog(
        JSON.parse(
          await this.load(
            '/legal/policies.json',
            'application/json',
            MAX_CATALOG_BYTES,
            signal,
          ),
        ),
        this.catalogOrigin,
      );
      if (!this.started || generation !== this.generation) return;
      assert(
        Object.hasOwn(catalog.policies, this.policy),
        'Policy type missing from catalog',
      );
      const revisions = catalog.policies[this.policy];
      const effective = selectEffective(revisions, this.now());
      const displayed = this.fixed
        ? revisions.find((record) => record.revision === this.fixed)
        : effective;
      if (this.fixed) assert(displayed, 'Dated revision missing from catalog');
      let article: HTMLElement | undefined;
      if (displayed) {
        if (this.fixed) {
          const current = this.documentHost.querySelector<HTMLElement>(
            'article[data-legal-article]',
          );
          assert(
            current?.dataset.policy === this.policy &&
              current.dataset.revision === displayed.revision &&
              current.dataset.sha256 === displayed.sha256 &&
              current.dataset.effectiveDate === displayed.effectiveDate,
            'Static article/catalog identity mismatch',
          );
        } else {
          article = importArticle(
            await this.load(
              revisionPath(this.policy, displayed.revision),
              'text/html',
              MAX_RENDERED_BYTES,
              signal,
            ),
            this.policy,
            displayed,
            document,
          );
        }
      }
      if (!this.started || generation !== this.generation) return;
      this.revisions = revisions;
      this.updateFallback();
      if (!displayed) {
        const heading = document.createElement('h1');
        heading.textContent = this.label;
        const message = document.createElement('p');
        message.textContent = revisions.length
          ? 'No policy is effective yet. Upcoming dated revisions are available below.'
          : 'This policy is not yet available. No approved revision has been published.';
        this.documentHost.replaceChildren(heading, message);
        document.title = `${this.label} | Klex`;
        this.status.textContent = revisions.length
          ? 'No effective revision (dates use 00:00 UTC).'
          : 'Policy unavailable.';
        this.fallback.hidden = false;
      } else {
        if (article) this.documentHost.replaceChildren(article);
        document.title = `${this.documentHost.querySelector('h1')?.textContent ?? this.label}${this.fixed ? ` — ${displayed.revision}` : ''} | Klex`;
        this.renderHistory(displayed);
        this.fallback.hidden = true;
        if (initial && window.location.hash) {
          try {
            const target = document.getElementById(
              decodeURIComponent(window.location.hash.slice(1)),
            );
            target?.scrollIntoView();
          } catch {
            /* Ignore malformed fragments. */
          }
        }
      }
      this.retry.hidden = true;
    } catch {
      if (!this.started || generation !== this.generation) return;
      this.status.textContent =
        'Could not verify the effective policy. Any document below remains its labeled dated revision; current status is unverified. Retry or use a dated link.';
      this.fallback.hidden = false;
      this.history.hidden = true;
      this.retry.hidden = false;
    } finally {
      window.clearTimeout(timeout);
      if (this.deadline === timeout) this.deadline = undefined;
      if (this.started && generation === this.generation) {
        this.documentHost.removeAttribute('aria-busy');
        this.timer = window.setTimeout(
          () => void this.refresh(),
          boundaryDelay(this.revisions, this.now()),
        );
      }
    }
  }

  private async load(
    path: string,
    mime: string,
    max: number,
    signal: AbortSignal,
  ): Promise<string> {
    const expected = new URL(path, this.deps.window.location.origin);
    const response = await this.deps.fetch(expected.href, {
      signal,
      cache: 'no-cache',
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
    assert(response.ok, 'Legal request failed');
    const actual = new URL(response.url || expected.href);
    assert(
      actual.origin === expected.origin &&
        [expected.pathname, `${expected.pathname}/`].includes(
          actual.pathname,
        ) &&
        !actual.search,
      'Unexpected legal response redirect',
    );
    assert(
      response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() === mime,
      'Unexpected legal content type',
    );
    return boundedText(response, max);
  }

  private updateFallback(): void {
    const { document } = this.deps;
    const list = document.createElement('ul');
    for (const revision of this.revisions) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = revisionPath(this.policy, revision.revision);
      link.textContent = `${revision.revision} — effective ${revision.effectiveDate} at 00:00 UTC`;
      item.append(link);
      list.append(item);
    }
    this.fallback.querySelector('ul')?.remove();
    this.fallback.querySelector('[data-empty-revisions]')?.remove();
    if (this.revisions.length) this.fallback.append(list);
  }

  private renderHistory(displayed: Revision): void {
    const { document } = this.deps;
    const state = revisionState(this.revisions, displayed, this.now());
    this.status.textContent =
      state.status === 'upcoming'
        ? `Upcoming revision. Effective ${displayed.effectiveDate} at 00:00 UTC; not current yet.`
        : state.status === 'historical'
          ? 'Previous version. This dated document is no longer current.'
          : 'Current effective revision (using your device’s UTC clock).';
    this.history.replaceChildren();
    if (state.status !== 'current' && state.current) {
      const current = document.createElement('a');
      current.href = `/legal/${this.policy}`;
      current.textContent = 'Read the current policy';
      this.history.append(current);
    }
    if (state.earlier.length) {
      const heading = document.createElement('h2');
      heading.textContent =
        state.status === 'current' ? 'Previous revision' : 'Earlier revisions';
      const list = document.createElement('ul');
      for (const revision of state.earlier) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = revisionPath(this.policy, revision.revision);
        link.textContent = `${revision.revision} — effective ${revision.effectiveDate} (UTC)`;
        item.append(link);
        list.append(item);
      }
      this.history.append(heading, list);
    }
    this.history.hidden = !this.history.childNodes.length;
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.generation++;
    this.request?.abort();
    this.deps.window.clearTimeout(this.timer);
    this.deps.window.clearTimeout(this.deadline);
    this.deps.window.removeEventListener('focus', this.onFocus);
    this.deps.window.removeEventListener('pageshow', this.onFocus);
    this.deps.document.removeEventListener('visibilitychange', this.onFocus);
    this.retry.removeEventListener('click', this.onRetry);
  }
}

export function createLegalPage(deps: LegalPageDependencies): LegalPage {
  return new LegalPageModule(deps);
}
