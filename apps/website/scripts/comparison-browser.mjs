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
  for (const width of [1440, 768, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.route('https://**/*', (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    const comparisons = page.getByRole('navigation', {
      name: 'Compare Klex Bots to...',
    });
    const link = comparisons.getByRole('link', { name: 'Rerun', exact: true });
    assert.equal(
      await page.locator('footer a[href="/compare/rerun"]').count(),
      1,
    );
    assert.equal(await link.getAttribute('href'), '/compare/rerun');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
      'homepage horizontal overflow at ' + width + 'px',
    );
    const footerSections = await page
      .locator('footer .new-footer-bottom > *')
      .all();
    const boxes = await Promise.all(
      footerSections.map((section) => section.boundingBox()),
    );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        assert(a && b);
        assert(
          a.x + a.width <= b.x + 1 ||
            b.x + b.width <= a.x + 1 ||
            a.y + a.height <= b.y + 1 ||
            b.y + b.height <= a.y + 1,
          'footer sections overlap at ' + width + 'px',
        );
      }
    }
    await link.focus();
    assert.equal(
      await link.evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Enter');
    await page.waitForURL('**/compare/rerun');
    assert.equal(new URL(page.url()).pathname, '/compare/rerun');
    assert.match(await page.locator('main h1').textContent(), /Klex vs Rerun/);
    assert.equal(
      await page.locator('main a[href="https://rerun.build/pricing"]').count(),
      1,
    );
    assert(
      (await page
        .locator('main a[href="https://docs.klex.bot/quickstart"]')
        .count()) >= 1,
    );
    const models = page.locator('#models');
    assert(
      await models
        .getByText('Do I need to arrange model access separately?')
        .isVisible(),
    );
    assert(await models.getByRole('heading', { name: 'Klex' }).isVisible());
    assert(
      await models.getByRole('heading', { name: 'Rerun Pro' }).isVisible(),
    );
    for (const link of await models.locator('a').all()) {
      assert(
        await link.getAttribute('href'),
        'comparison source has a destination',
      );
      assert.match(
        await link.evaluate((el) => getComputedStyle(el).textDecorationLine),
        /underline/,
      );
    }
    assert.equal(await page.locator('.comparison-at-a-glance h2').count(), 2);
    if (width === 1440) {
      const hero = await page.locator('.comparison-heading').boundingBox();
      const card = await page.locator('.comparison-at-a-glance').boundingBox();
      assert(
        hero &&
          card &&
          hero.width > width * 0.8 &&
          card.x > hero.x + hero.width / 2,
        'desktop hero uses the available width',
      );
    }
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
