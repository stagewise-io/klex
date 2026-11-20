import { strict as assert } from 'node:assert';

import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
const address = server.httpServer.address();
assert(address && typeof address !== 'string');
const base = 'http://127.0.0.1:' + address.port;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.route('https://**/*', (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    const link = page.locator('footer a[href="/compare/rerun"]');
    assert.equal(await link.count(), 1, 'footer exposes comparison');
    await link.click();
    assert.equal(new URL(page.url()).pathname, '/compare/rerun');
    assert.match(await page.locator('main h1').textContent(), /Klex vs Rerun/);
    assert.equal(
      await page.locator('main a[href="https://rerun.build/pricing"]').count(),
      1,
    );
    assert.equal(
      await page
        .locator('main a[href="https://docs.klex.bot/quickstart"]')
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator('main a[href="https://www.klex.bot/"]')
        .last()
        .textContent(),
      'Explore Klex',
    );
    assert(
      await page
        .locator('meta[name="robots"]')
        .getAttribute('content')
        .then((v) => v.includes('noindex')),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
      'horizontal overflow at ' + width + 'px',
    );
    await page.locator('main a[href="https://rerun.build/pricing"]').focus();
    assert.equal(
      await page
        .locator('main a[href="https://rerun.build/pricing"]')
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(
      await page
        .locator('main a[href="https://rerun.build/pricing"]')
        .evaluate(
          (el) =>
            el.matches(':focus-visible') &&
            getComputedStyle(el).outlineStyle !== 'none',
        ),
      true,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({
    locale: 'ar',
    viewport: { width: 390, height: 900 },
  });
  await context.route('https://**/*', (route) => route.abort());
  await context.addCookies([{ name: 'klex-language', value: 'ar', url: base }]);
  const page = await context.newPage();
  await page.goto(base + '/compare/rerun');
  await page.waitForFunction(() => document.documentElement.lang === 'ar');
  assert.equal(await page.locator('main').getAttribute('lang'), 'en');
  assert.equal(await page.locator('main').getAttribute('dir'), 'ltr');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await context.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJs.newPage();
  await staticPage.goto(base + '/compare/rerun');
  assert.equal(
    await staticPage.locator('main h1').count(),
    1,
    'comparison is readable without JavaScript',
  );
  await noJs.close();
  console.log('Comparison browser checks passed');
} finally {
  await browser?.close();
  server.httpServer.close();
}
