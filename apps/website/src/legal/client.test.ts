// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  boundedText,
  createLegalPage,
  importArticle,
  type LegalPage,
} from './client';
import { fixtureSources, template } from './fixtures';
import { createCatalog, generateArtifacts } from './node';

const sources = fixtureSources();
const artifacts = generateArtifacts(sources, template);
const catalog = createCatalog(sources);
const handles: LegalPage[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mount(path = 'legal/privacy/index.html') {
  const parsed = new DOMParser().parseFromString(
    String(artifacts.get(path)),
    'text/html',
  );
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
}
function setup({
  path,
  dates,
  now = () => new Date('2021-05-01T00:00:00Z'),
}: {
  path?: string;
  dates?: string[];
  now?: () => Date;
} = {}) {
  mount(path);
  const responses = dates
    ? generateArtifacts(fixtureSources(dates), template)
    : artifacts;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname.slice(1);
    const key = responses.has(path) ? path : `${path}/index.html`;
    const body = responses.get(key);
    return new Response(body === undefined ? 'Missing' : String(body), {
      status: body === undefined ? 404 : 200,
      headers: {
        'Content-Type': key.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'text/html; charset=utf-8',
      },
    });
  });
  const handle = createLegalPage({ document, window, fetch: fetcher, now });
  handles.push(handle);
  return { handle, fetcher };
}
const status = () => document.getElementById('legal-status')?.textContent;
const article = () =>
  document.querySelector<HTMLElement>('article[data-legal-article]');
const historyLinks = () =>
  [...document.querySelectorAll('#legal-history a')].map((link) =>
    link.getAttribute('href'),
  );

describe('legal reader selection and failure behavior', () => {
  it('loads latest effective revision, updates title and links only its predecessor', async () => {
    const { handle, fetcher } = setup();
    await handle.start();
    await handle.start();
    expect(article()?.dataset.revision).toBe('2021-01-01');
    expect(status()).toContain('Current effective');
    expect(document.title).toBe('Synthetic privacy 2021-01-01 | Klex');
    expect(historyLinks()).toEqual(['/legal/privacy/2020-01-01']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      cache: 'no-cache',
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
  });
  it.each([
    [
      '2020-01-01',
      'Previous version',
      ['/legal/privacy', '/legal/privacy/2019-01-01'],
    ],
    [
      '2099-01-01',
      'Upcoming',
      [
        '/legal/privacy',
        '/legal/privacy/2021-01-01',
        '/legal/privacy/2020-01-01',
        '/legal/privacy/2019-01-01',
      ],
    ],
  ])(
    'keeps fixed %s content and renders truthful history',
    async (revision, label, links) => {
      const { handle, fetcher } = setup({
        path: `legal/privacy/${revision}/index.html`,
      });
      await handle.start();
      expect(article()?.dataset.revision).toBe(revision);
      expect(status()).toContain(label);
      expect(historyLinks()).toEqual(links);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not claim current content for empty or future-only catalogs', async () => {
    const first = setup({ dates: [] });
    await first.handle.start();
    expect(status()).toBe('Policy unavailable.');
    expect(article()).toBeNull();
    first.handle.close();
    const upcoming = setup({ dates: ['2099-01-01'] });
    await upcoming.handle.start();
    expect(status()).toContain('No effective revision');
    expect(article()).toBeNull();
    expect(
      document.querySelector('#legal-fallback a')?.getAttribute('href'),
    ).toBe('/legal/privacy/2099-01-01');
  });
  it('refreshes automatically at midnight and on focus, then cleans up listeners/timers', async () => {
    vi.useFakeTimers();
    let now = new Date('2020-12-31T23:59:59.000Z');
    const { handle, fetcher } = setup({ now: () => now });
    await handle.start();
    expect(article()?.dataset.revision).toBe('2020-01-01');
    now = new Date('2021-01-01T00:00:00.000Z');
    await vi.advanceTimersByTimeAsync(1000);
    expect(article()?.dataset.revision).toBe('2021-01-01');
    const calls = fetcher.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() =>
      expect(fetcher.mock.calls.length).toBeGreaterThan(calls),
    );
    handle.close();
    handle.close();
    const closedCalls = fetcher.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(86400000);
    expect(fetcher).toHaveBeenCalledTimes(closedCalls);
  });
  it('keeps dated content readable on errors, clears current status, and supports retry', async () => {
    const { handle, fetcher } = setup();
    await handle.start();
    const previous = article();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await handle.refresh();
    expect(article()).toBe(previous);
    expect(status()).toContain('current status is unverified');
    expect(document.getElementById('legal-retry')?.hidden).toBe(false);
    expect(document.getElementById('legal-history')?.hidden).toBe(true);
    document.getElementById('legal-retry')?.click();
    await vi.waitFor(() => expect(status()).toContain('Current effective'));
  });
  it.each([
    new Response('<html>SPA fallback</html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
    new Response('not json', {
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response('{}', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({ schemaVersion: 1, policies: {} }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ])(
    'fails closed on bad status, MIME, malformed JSON and missing policy types',
    async (response) => {
      const { handle, fetcher } = setup();
      fetcher.mockResolvedValueOnce(response);
      await handle.start();
      expect(status()).toContain('unverified');
      expect(article()).toBeNull();
      expect(document.getElementById('legal-fallback')?.hidden).toBe(false);
    },
  );
  it('rejects mismatched dated metadata rather than switching documents', async () => {
    const { handle } = setup({ path: 'legal/privacy/2020-01-01/index.html' });
    const displayed = article();
    if (!displayed) throw new Error('Synthetic dated article missing');
    displayed.dataset.sha256 = '0'.repeat(64);
    await handle.start();
    expect(status()).toContain('unverified');
    expect(article()?.dataset.revision).toBe('2020-01-01');
  });
  it('rejects unexpected redirect destinations', async () => {
    const { handle, fetcher } = setup();
    const response = new Response(JSON.stringify(catalog), {
      headers: { 'Content-Type': 'application/json' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://evil.invalid/legal/policies.json',
    });
    fetcher.mockResolvedValueOnce(response);
    await handle.start();
    expect(status()).toContain('unverified');
  });
  it('a newer refresh wins even if an older fetch ignores cancellation', async () => {
    const { handle, fetcher } = setup();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const initial = handle.start();
    await handle.refresh();
    const rendered = article();
    release(
      new Response(JSON.stringify(catalog), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await initial;
    expect(article()).toBe(rendered);
    expect(status()).toContain('Current effective');
  });
});

describe('safe article import and bounded HTTP decoding', () => {
  const revision = catalog.policies.privacy[1];
  const html = String(artifacts.get('legal/privacy/2021-01-01/index.html'));
  it('imports one matching article with safe semantics and no event/style attributes', () => {
    const value = importArticle(
      html.replace('<h1>', '<h1 onclick="bad()" style="color:red">'),
      'privacy',
      revision,
      document,
    );
    expect(value.querySelector('h1')?.hasAttribute('onclick')).toBe(false);
    expect(value.querySelector('h1')?.hasAttribute('style')).toBe(false);
    expect(value.querySelector('#section-scope')).not.toBeNull();
    expect(value.querySelector('a[download]')).not.toBeNull();
  });
  it.each([
    (value: string) => value.replace('data-sha256="', 'data-sha256="bad'),
    (value: string) =>
      value.replace('</article>', '<script>bad()</script></article>'),
    (value: string) =>
      value.replace('href="#section-scope"', 'href="javascript:alert(1)"'),
    (value: string) =>
      value.replace('</article>', '<h1>Another title</h1></article>'),
  ])('rejects unsafe/mismatched imports', (mutate) =>
    expect(() =>
      importArticle(mutate(html), 'privacy', revision, document),
    ).toThrow(),
  );
  it('rejects oversized content and invalid UTF-8 and decodes normal streams', async () => {
    await expect(
      boundedText(
        new Response('hello', { headers: { 'Content-Length': '10' } }),
        5,
      ),
    ).rejects.toThrow('too large');
    await expect(boundedText(new Response('abcdef'), 5)).rejects.toThrow(
      'too large',
    );
    await expect(
      boundedText(new Response(new Uint8Array([0xff])), 5),
    ).rejects.toThrow();
    await expect(boundedText(new Response('hello'), 5)).resolves.toBe('hello');
  });
});
