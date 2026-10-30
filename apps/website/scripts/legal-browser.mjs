import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { build, createServer, preview } from 'vite';

import { registry, syntheticMarkdown } from '../src/legal/fixtures.ts';
import { createLegalPlugin } from '../src/legal/node/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'klex-legal-browser-'));
let server;
let devServer;
let browser;
try {
  const contentRoot = join(temporary, 'content');
  await mkdir(contentRoot);
  await writeFile(join(contentRoot, 'policies.json'), JSON.stringify(registry));
  for (const policy of ['privacy', 'terms', 'dpa']) {
    await mkdir(join(contentRoot, policy));
    for (const revision of [
      '2019-01-01',
      '2020-01-01',
      '2021-01-01',
      '2099-01-01',
    ]) {
      await writeFile(
        join(contentRoot, policy, `${revision}.md`),
        syntheticMarkdown(policy, revision, revision === '2021-01-01'),
      );
    }
  }
  const config = {
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      tailwindcss(),
      createLegalPlugin({
        contentRoot,
        templatePath: join(root, 'legal/index.html'),
      }),
    ],
    resolve: { alias: { '@': join(root, 'src') } },
    build: {
      outDir: join(temporary, 'dist'),
      emptyOutDir: true,
      rollupOptions: { input: { legal: join(root, 'legal/index.html') } },
    },
    preview: { host: '127.0.0.1', port: 0 },
  };
  await build(config);
  server = await preview(config);
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const catalogResponse = await fetch(`${base}/legal/policies.json`);
  assert.equal(catalogResponse.status, 200);
  assert.match(
    catalogResponse.headers.get('content-type'),
    /application\/json/,
  );
  assert.equal(catalogResponse.headers.get('cache-control'), 'no-cache');
  const catalog = await catalogResponse.json();
  for (const entries of Object.values(catalog.policies)) {
    for (const entry of entries) {
      assert.equal(entry.requiresConsent, entry.revision === '2021-01-01');
      const path = new URL(entry.markdownUrl).pathname;
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/markdown/);
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(await response.arrayBuffer()))
          .digest('hex'),
        entry.sha256,
      );
      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    }
  }
  for (const path of [
    '/legal/nope',
    '/legal/privacy/2020-02-02',
    '/legal/privacy/nope.md',
    '/legal',
    '/legal/nope.json',
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  browser = await chromium.launch({ headless: true });
  devServer = await createServer({
    ...config,
    server: { host: '127.0.0.1', port: 0 },
  });
  await devServer.listen();
  const devAddress = devServer.httpServer.address();
  assert(devAddress && typeof devAddress !== 'string');
  const results = join(root, 'test-results');
  await mkdir(results, { recursive: true });
  for (const [mode, origin] of [
    ['production', base],
    ['development', `http://127.0.0.1:${devAddress.port}`],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const stalled = await browser.newContext({
        colorScheme,
        viewport: { width: 390, height: 844 },
      });
      let releaseScripts;
      const scriptsReady = new Promise((resolve) => {
        releaseScripts = resolve;
      });
      await stalled.route('**/*', async (route) => {
        if (route.request().resourceType() === 'script') await scriptsReady;
        await route.continue();
      });
      const firstPaint = await stalled.newPage();
      try {
        await firstPaint.goto(`${origin}/legal/privacy/2020-01-01`, {
          waitUntil: 'commit',
        });
        await firstPaint.waitForFunction(
          () =>
            document.querySelector('.legal-main') &&
            document.querySelector('.new-footer'),
        );
        await firstPaint.waitForFunction(
          () => document.querySelector('link[rel="stylesheet"]')?.sheet,
        );
        const initial = await firstPaint.evaluate(() => ({
          dark: document.documentElement.classList.contains('dark'),
          mainFont: getComputedStyle(document.querySelector('.legal-main'))
            .fontSize,
          bodyMargin: getComputedStyle(document.body).margin,
          gutter: getComputedStyle(document.documentElement)
            .getPropertyValue('--page-gutter')
            .trim(),
          sourceVisible:
            getComputedStyle(document.querySelector('[data-legal-article]'))
              .display !== 'none',
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }));
        assert.equal(
          initial.dark,
          colorScheme === 'dark',
          `${mode}: correct theme before modules load`,
        );
        assert.equal(
          initial.mainFont,
          '17px',
          `${mode}: legal CSS before modules load`,
        );
        assert.equal(
          initial.bodyMargin,
          '0px',
          `${mode}: base CSS before modules load`,
        );
        assert.equal(
          initial.gutter,
          '24px',
          `${mode}: responsive CSS before modules load`,
        );
        assert.equal(
          initial.sourceVisible,
          true,
          `${mode}: content remains readable without module execution`,
        );
        assert.equal(await firstPaint.locator('.new-footer').count(), 1);
        assert.equal(await firstPaint.locator('.legal-footer').count(), 0);
        assert.equal(await firstPaint.locator('.new-footer-main').count(), 0);
        assert.equal(await firstPaint.locator('.new-footer-cta').count(), 0);
        assert.equal(await firstPaint.locator('.legal-types').count(), 0);
        assert.equal(
          await firstPaint
            .locator('.new-footer a[href="/legal/privacy"]')
            .count(),
          1,
        );
        assert.equal(
          await firstPaint
            .locator('.new-footer a[href="/legal/terms"]')
            .count(),
          1,
        );
        assert.equal(
          await firstPaint
            .locator('.new-footer-bottom')
            .evaluate((element) => getComputedStyle(element).display),
          'flex',
        );
        assert.equal(
          initial.overflow,
          false,
          `${mode}: no initial horizontal overflow`,
        );
        await firstPaint.screenshot({
          path: join(results, `legal-first-paint-${mode}-${colorScheme}.png`),
          fullPage: true,
        });
      } finally {
        releaseScripts();
        await stalled.close();
      }
    }
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(base)) externalRequests.push(request.url());
  });
  await page.clock.install({ time: new Date('2020-12-31T23:59:59.000Z') });
  await page.clock.pauseAt(new Date('2020-12-31T23:59:59.000Z'));
  const contrast = () =>
    page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const luminance = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const foreground = luminance(
        getComputedStyle(document.querySelector('.legal-prose a')).color,
      );
      const background = luminance(
        getComputedStyle(document.documentElement).backgroundColor,
      );
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  const displayed = (revision) =>
    page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-legal-article]')
          ?.getAttribute('data-revision') === expected &&
        document
          .getElementById('legal-status')
          ?.textContent.includes('Current effective'),
      revision,
    );
  await page.goto(`${base}/legal/privacy#section-scope`);
  await displayed('2020-01-01');
  assert.deepEqual(
    await page
      .locator('#legal-history a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    ['/legal/privacy/2019-01-01'],
  );
  await page.clock.fastForward(1000);
  await displayed('2021-01-01');
  assert.equal(await page.title(), 'Synthetic privacy 2021-01-01 | Klex');
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(
    await page.locator('a[download]').getAttribute('href'),
    '/legal/privacy/2021-01-01.md',
  );
  assert((await contrast()) >= 4.5, 'Light-theme link contrast');
  assert.equal(
    await page
      .locator('.legal-prose ul')
      .evaluate((element) => getComputedStyle(element).listStyleType),
    'disc',
  );
  await page.goto(`${base}/legal/privacy`);
  await displayed('2021-01-01');
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .locator('.new-skip-link')
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  assert.equal(
    await page
      .locator('#legal-main')
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.screenshot({
    path: join(results, 'legal-desktop.png'),
    fullPage: true,
  });
  await page.goto(`${base}/legal/privacy/2020-01-01/`);
  await page.waitForFunction(() =>
    document
      .getElementById('legal-status')
      ?.textContent.includes('Previous version'),
  );
  assert.equal(
    await page.locator('[data-legal-article]').getAttribute('data-revision'),
    '2020-01-01',
  );
  assert.deepEqual(
    await page
      .locator('#legal-history a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    ['/legal/privacy', '/legal/privacy/2019-01-01'],
  );
  await page.goto(`${base}/legal/privacy/2099-01-01`);
  await page.waitForFunction(() =>
    document.getElementById('legal-status')?.textContent.includes('Upcoming'),
  );
  await page.route('**/legal/policies.json', (route) => route.abort());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() =>
    document.getElementById('legal-status')?.textContent.includes('unverified'),
  );
  assert.equal(
    await page.locator('[data-legal-article]').getAttribute('data-revision'),
    '2099-01-01',
  );
  await page.unroute('**/legal/policies.json');
  await page.locator('#legal-retry').click();
  await page.waitForFunction(() =>
    document.getElementById('legal-status')?.textContent.includes('Upcoming'),
  );
  await page.goto(`${base}/legal/dpa/`);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-legal-article]')
        ?.getAttribute('data-policy') === 'dpa',
  );
  await page.goto(`${base}/legal/terms/2021-01-01`);
  await page.waitForFunction(() =>
    document
      .getElementById('legal-status')
      ?.textContent.includes('Current effective'),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    'Mobile overflow',
  );
  assert((await contrast()) >= 4.5, 'Dark-theme link contrast');
  await page.screenshot({
    path: join(results, 'legal-mobile-dark.png'),
    fullPage: true,
  });
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.new-header').isVisible(), false);
  assert.equal(await page.locator('.legal-history').isVisible(), false);
  assert.equal(await page.locator('.new-footer').isVisible(), false);
  assert.equal(await page.locator('[data-legal-article]').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    externalRequests,
    [],
    'Legal pages must not initialize analytics or load third-party assets',
  );
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await nojs.newPage();
  await staticPage.goto(`${base}/legal/privacy/2020-01-01`);
  assert.equal(
    await staticPage
      .locator('[data-legal-article]')
      .getAttribute('data-revision'),
    '2020-01-01',
  );
  assert.equal(await staticPage.locator('#legal-fallback a').count(), 4);
  assert.equal(await staticPage.locator('.new-footer').count(), 1);
  assert.equal(await staticPage.locator('.new-footer').isVisible(), true);
  assert.equal(await staticPage.locator('.new-footer-main').count(), 0);
  assert.equal(await staticPage.locator('.legal-types').count(), 0);
  assert.equal(
    await staticPage
      .locator('.new-footer a[href="/legal/privacy"]')
      .isVisible(),
    true,
  );
  assert.equal(
    await staticPage.locator('.new-footer a[href="/legal/terms"]').isVisible(),
    true,
  );
  await staticPage.goto(`${base}/legal/privacy/`);
  assert.equal(await staticPage.locator('[data-legal-article]').count(), 0);
  assert.equal(await staticPage.locator('#legal-fallback').isVisible(), true);
  assert.equal(await staticPage.locator('#legal-fallback a').count(), 4);
  const html = await readFile(
    join(temporary, 'dist/legal/privacy/index.html'),
    'utf8',
  );
  assert(!html.includes('src/legal/main.ts'));
  assert.match(html, /\/assets\/legal-[^"]+\.js/);
  console.log(
    'Legal browser smoke passed: shared site footer, styled first paint with delayed modules in dev/production, built fixture pages, UTC transition, revision history, headers/hash downloads, real 404s, retry, DPA, mobile/dark/print, no-JS and no analytics.',
  );
} finally {
  await browser?.close();
  await devServer?.close();
  await new Promise((resolve, reject) =>
    server
      ? server.httpServer.close((error) => (error ? reject(error) : resolve()))
      : resolve(),
  );
  await rm(temporary, { recursive: true, force: true });
}
