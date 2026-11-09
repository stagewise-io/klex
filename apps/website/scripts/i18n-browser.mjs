import { strict as assert } from 'node:assert';

import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
const address = server.httpServer.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      locale: 'de-DE',
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.route('https://**/*', (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const locale of [
      'en',
      'zh',
      'ja',
      'ko',
      'de',
      'fr',
      'es',
      'pt',
      'hi',
      'uk',
      'ru',
      'ar',
    ]) {
      await context.addCookies([
        { name: 'klex-language', value: locale, url: base },
      ]);
      await page.goto(base);
      await page.waitForFunction(
        (language) => document.documentElement.lang === language,
        locale,
      );
      await page.evaluate(() => document.fonts.ready);
      const heading = await page.locator('.new-hero h1').evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          maxWidth: style.maxWidth,
        };
      });
      assert(
        heading.width <= Math.min(width - 48, 896) + 1,
        `${locale} hero exceeds its text column at ${width}px`,
      );
      assert.notEqual(
        heading.maxWidth,
        'none',
        `${locale} hero has no width limit`,
      );
      if (locale === 'en' && width === 1440)
        assert(
          heading.height / heading.lineHeight >= 1.9,
          'English hero must wrap to multiple lines',
        );
      assert(
        !(await page.locator('.office-caption').textContent()).includes(
          'Our Klex Bots are not physically',
        ) || locale === 'en',
      );
    }
    await context.clearCookies();
    await page.goto(base);
    await page.waitForFunction(() => document.documentElement.lang === 'de');
    assert.equal(
      await page
        .locator('[data-language-placement="footer"]')
        .getAttribute('data-language-value'),
      'auto',
    );
    assert(!(await page.locator('h1').textContent()).includes('Your own team'));
    assert.equal(await page.locator('select[data-language]').count(), 0);
    assert.equal(
      await page
        .locator('[data-language-placement="footer"] svg:visible')
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator('[data-language-placement="footer"] .new-language-name')
        .textContent(),
      'Deutsch',
    );
    assert.equal(
      await page.locator('.new-footer-utilities [data-cloud-status]').count(),
      1,
    );
    if (width === 390) {
      await page
        .getByRole('button', { name: 'Navigation öffnen', exact: true })
        .click();
      await page.locator('[data-language-placement="menu"]').click();
      await page
        .getByRole('option', { name: 'Deutsch (Standard)', exact: true })
        .waitFor();
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: 'Navigation schließen', exact: true })
        .click();
    } else {
      const headerTrigger = page.locator('[data-language-placement="header"]');
      assert.equal(
        await headerTrigger.locator('.new-language-name').count(),
        0,
      );
      const headerStyle = await headerTrigger.evaluate((el) => {
        const s = getComputedStyle(el);
        return { radius: s.borderRadius, border: s.borderTopWidth };
      });
      assert.equal(headerStyle.radius, '50%');
      assert.equal(headerStyle.border, '1px');
      await headerTrigger.click();
      await page
        .getByRole('option', { name: 'Deutsch (Standard)', exact: true })
        .waitFor();
      await page.keyboard.press('Escape');
    }
    await page.locator('[data-language-placement="footer"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await page
        .locator('[data-language-menu="footer"]')
        .getByRole('option')
        .count(),
      12,
    );
    assert.equal(
      await page
        .locator('[data-language-menu="footer"]')
        .getByRole('option', { name: 'Deutsch', exact: true })
        .count(),
      0,
    );
    await page
      .locator('[data-language-menu="footer"]')
      .getByRole('option', { name: 'Français', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.cookie.includes('klex-language=fr') &&
        document.documentElement.lang === 'fr',
    );
    assert.equal(new URL(page.url()).searchParams.has('lang'), false);
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    assert.equal(
      (await context.cookies(base)).find(
        (cookie) => cookie.name === 'klex-language',
      )?.value,
      'fr',
    );
    await page.goto(`${base}/brand`);
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    assert.equal(
      await page
        .locator('[data-language-placement="footer"]')
        .getAttribute('data-language-value'),
      'fr',
    );
    await context.addCookies([
      { name: 'klex-language', value: 'ar', url: base },
    ]);
    await page.goto(`${base}/press?lang=fr`);
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    assert.equal(
      await page
        .locator('[data-language-placement="footer"]')
        .getAttribute('data-language-value'),
      'ar',
    );
    assert.equal(
      (await context.cookies(base)).find(
        (cookie) => cookie.name === 'klex-language',
      )?.value,
      'ar',
    );
    assert.equal(new URL(page.url()).searchParams.has('lang'), false);
    assert(await page.locator('h1').textContent());
    assert.equal(await page.locator('#press-product-title').count(), 1);
    await page.goto(base);
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    if (process.env.I18N_SCREENSHOTS)
      await page.screenshot({ path: `dist/i18n-ar-hero-${width}.png` });
    await page.locator('#how-it-works').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    if (width === 390) {
      await page
        .locator('.new-workflow-mobile-steps button[data-step="1"]')
        .click();
      await page.waitForTimeout(600);
      assert.equal(
        await page.locator('.new-workflow-step[data-active="true"]').count(),
        1,
      );
    }
    if (process.env.I18N_SCREENSHOTS)
      await page.screenshot({ path: `dist/i18n-ar-workflow-${width}.png` });
    await page.locator('.new-footer').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, `Arabic page overflows at ${width}px`);
    await page.locator('[data-language-placement="footer"]').click();
    await page
      .locator('[data-language-menu="footer"]')
      .getByRole('option')
      .first()
      .click();
    await page.waitForURL(`${base}/`);
    await page.waitForFunction(() => document.documentElement.lang === 'de');
    assert.equal(
      (await context.cookies(base)).find(
        (cookie) => cookie.name === 'klex-language',
      )?.value,
      'auto',
    );
    await context.addCookies([
      { name: 'klex-language', value: 'ar', url: base },
    ]);
    await page.goto(`${base}/legal/privacy`);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
    assert.equal(
      await page
        .locator('[data-language-placement="footer"]')
        .getAttribute('data-language-value'),
      'ar',
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Language detection, override, persistence, reset, RTL and legal isolation passed at ${width}px.`,
    );
  }
  // Exercise real browser cookie scoping on synthetic HTTPS origins; no production requests.
  const shared = await browser.newContext({ locale: 'en-US' });
  await shared.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cloud.klex.bot') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Cookie contract test</title>',
      });
    } else if (url.hostname === 'www.klex.bot') {
      const response = await shared.request.get(
        `${base}${url.pathname}${url.search}`,
      );
      await route.fulfill({ response });
    } else await route.abort();
  });
  await shared.addInitScript(() => {
    if (
      location.hostname === 'www.klex.bot' &&
      !localStorage.getItem('cookie-migration-tested')
    ) {
      localStorage.setItem('klex-language', 'fr');
      localStorage.setItem('cookie-migration-tested', 'true');
    }
  });
  const website = await shared.newPage();
  await website.goto('https://www.klex.bot/');
  await website.waitForFunction(() => document.documentElement.lang === 'fr');
  assert.equal(
    await website.evaluate(() => localStorage.getItem('klex-language')),
    null,
  );
  const cookie = (await shared.cookies('https://cloud.klex.bot/')).find(
    (value) => value.name === 'klex-language',
  );
  assert(cookie);
  assert.equal(cookie.domain, '.klex.bot');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.value, 'fr');
  const cloud = await shared.newPage();
  await cloud.goto('https://cloud.klex.bot/');
  assert.equal(await cloud.evaluate(() => document.cookie), 'klex-language=fr');
  await cloud.evaluate(() => {
    document.cookie =
      'klex-language=de; Domain=klex.bot; Path=/; Max-Age=31536000; Secure; SameSite=Lax';
  });
  await website.reload();
  await website.waitForFunction(() => document.documentElement.lang === 'de');
  await website.locator('[data-language-placement="footer"]').click();
  await website
    .locator('[data-language-menu="footer"]')
    .getByRole('option')
    .first()
    .click();
  await website.waitForFunction(() => document.documentElement.lang === 'en');
  await cloud.reload();
  assert.equal(
    await cloud.evaluate(() => document.cookie),
    'klex-language=auto',
  );
  await shared.close();
  console.log(
    'Cross-subdomain cookie sharing, migration, and automatic reset passed on synthetic HTTPS origins.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
