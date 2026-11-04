import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

import { registry, syntheticMarkdown } from '../src/legal/fixtures.ts';
import { createLegalPlugin } from '../src/legal/node/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'klex-legal-browser-'));
let server;
let browser;
try {
  const contentRoot = join(temporary, 'content');
  await mkdir(contentRoot);
  await writeFile(join(contentRoot, 'policies.json'), JSON.stringify(registry));
  for (const policy of ['privacy', 'terms', 'dpa']) {
    await mkdir(join(contentRoot, policy));
    for (const date of [
      '2019-01-01',
      '2020-01-01',
      '2021-01-01',
      '2099-01-01',
    ]) {
      await writeFile(
        join(contentRoot, policy, `${date}.md`),
        syntheticMarkdown(policy, date),
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
  const catalog = await (await fetch(`${base}/legal/policies.json`)).json();
  for (const entries of Object.values(catalog.policies)) {
    for (const entry of entries) {
      const response = await fetch(
        `${base}${new URL(entry.markdownUrl).pathname}`,
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/markdown/);
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(await response.arrayBuffer()))
          .digest('hex'),
        entry.sha256,
      );
    }
  }
  for (const path of [
    '/legal/nope',
    '/legal/privacy/nope.md',
    '/legal/privacy/2020-02-02',
  ]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
  browser = await chromium.launch({ headless: true });
  for (const javaScriptEnabled of [true, false]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        javaScriptEnabled,
        colorScheme,
        viewport: { width: 390, height: 844 },
      });
      const requests = [];
      const errors = [];
      await context.route('**/*', async (route) => {
        if (['fetch', 'xhr'].includes(route.request().resourceType())) {
          requests.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      for (const policy of ['privacy', 'terms', 'dpa']) {
        await page.goto(`${base}/legal/${policy}#section-scope`);
        assert.equal(
          await page.locator('h1').textContent(),
          `Synthetic ${policy} 2021-01-01`,
        );
        assert.equal(
          await page.locator('article').getAttribute('data-revision'),
          '2021-01-01',
        );
        assert.equal(await page.locator('.legal-notice').count(), 0);
        assert.equal(
          await page
            .locator('a[download], .legal-source, #legal-retry')
            .count(),
          0,
        );
        assert.equal(
          await page.locator('.legal-back a').getAttribute('href'),
          '/legal',
        );
        assert.equal(await page.locator('#legal-history a').count(), 1);
        assert.equal(
          await page.locator('#legal-history a').getAttribute('href'),
          `/legal/${policy}/2020-01-01`,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert(
          await page
            .locator('#section-scope')
            .evaluate((el) => el.getBoundingClientRect().top < innerHeight),
        );
        if (javaScriptEnabled) {
          await page.clock.install({ time: new Date('2100-01-01') });
          await page.clock.fastForward(86_400_000);
          assert.equal(
            await page.locator('article').getAttribute('data-revision'),
            '2021-01-01',
          );
          await page.clock.resume();
        }
        await page.goto(`${base}/legal/${policy}/2020-01-01`);
        assert.match(
          await page.locator('.legal-notice').textContent(),
          /Previous version/,
        );
        await page.goto(`${base}/legal/${policy}/2099-01-01`);
        assert.match(
          await page.locator('.legal-notice').textContent(),
          /Upcoming version/,
        );
      }
      await page.goto(`${base}/legal`);
      assert.equal(await page.locator('#legal-center nav a').count(), 3);
      assert.equal(
        requests.length,
        0,
        'No runtime fetch/XHR requests, even with all such requests blocked',
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(
    'Static legal browser smoke passed: build-time selection, no runtime requests, blocked fetch/XHR, no-JS, mobile/light/dark, hash navigation, version notices, history, source integrity and 404s.',
  );
} finally {
  await browser?.close();
  if (server)
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(temporary, { recursive: true, force: true });
}
