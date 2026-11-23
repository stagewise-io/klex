import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';

const kit = path.dirname(fileURLToPath(import.meta.url));
// Set LD_LIBRARY_PATH externally when Chromium requires a local sysroot.
const palette = await fs.readFile(kit + '/palette.css', 'utf8'),
  font = await fs.readFile(kit + '/geist-variable.woff2'),
  logo = await fs.readFile(kit + '/klex-unframed.svg');
const roles = {
  canvas: '--color-base-50',
  ink: '--color-base-900',
  muted: '--color-base-500',
  border: '--color-base-250',
  internal: '--color-base-500',
  scope: '--color-brand-50',
  scopeBorder: '--color-brand-150',
  accent: '--color-brand-500',
  grid: '--color-base-200',
};
for (const t of Object.values(roles))
  if (!palette.includes(t + ':')) throw Error('Undefined palette token ' + t);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 640 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  await page.context().setOffline(true);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(
    '<style>' + palette.replaceAll('@theme default', ':root') + '</style>',
  );
  const colors = await page.evaluate((roles) => {
    const result = {};
    for (const [role, token] of Object.entries(roles)) {
      const e = document.createElement('i');
      e.style.background = 'var(' + token + ')';
      document.body.append(e);
      const v = getComputedStyle(e).backgroundColor;
      if (v === 'rgba(0, 0, 0, 0)') throw Error('Unresolved ' + token);
      const ctx = document
        .createElement('canvas')
        .getContext('2d', { colorSpace: 'srgb' });
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, 1, 1);
      const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      result[role] = {
        token,
        hex: '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''),
        rgb,
      };
      e.remove();
    }
    return result;
  }, roles);
  const C = Object.fromEntries(
    Object.entries(colors).map(([k, v]) => [k, v.hex]),
  );
  const lum = (rgb) =>
    rgb
      .map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => {
    const x = lum(colors[a].rgb),
      y = lum(colors[b].rgb);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const contrastQA = {
    body: contrast('ink', 'canvas'),
    helperOnCanvas: contrast('muted', 'canvas'),
    helperOnScope: contrast('muted', 'scope'),
    blueRoute: contrast('accent', 'canvas'),
  };
  const gridBG = colors.canvas.rgb.map((v, i) =>
    Math.floor(v * 0.65 + colors.grid.rgb[i] * 0.35),
  );
  const onGrid = (role) =>
    (Math.max(lum(colors[role].rgb), lum(gridBG)) + 0.05) /
    (Math.min(lum(colors[role].rgb), lum(gridBG)) + 0.05);
  Object.assign(contrastQA, {
    inkOnGrid: onGrid('ink'),
    helperOnGrid: onGrid('muted'),
    blueRouteOnGrid: onGrid('accent'),
  });
  if (Object.values(contrastQA).some((v) => v < 4.5))
    throw Error('Insufficient text contrast ' + JSON.stringify(contrastQA));
  const css =
    '@font-face{font-family:Geist;src:url(data:font/woff2;base64,' +
    font.toString('base64') +
    ') format("woff2");font-weight:100 900;font-display:block}text{font-family:Geist,sans-serif;font-synthesis:none;fill:' +
    C.ink +
    '}.label{font-weight:550}.helper{fill:' +
    C.muted +
    ';font-weight:400}.route{fill:none;stroke:' +
    C.accent +
    ';stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}.internal{fill:none;stroke:' +
    C.internal +
    ';stroke-width:3;stroke-linecap:round}.card{fill:' +
    C.canvas +
    ';stroke:' +
    C.border +
    ';stroke-width:2}.icon{fill:none;stroke:' +
    C.ink +
    ';stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.mcp{fill:' +
    C.accent +
    ';font-weight:550}';
  const logoURI = 'data:image/svg+xml;base64,' + logo.toString('base64');
  const alt =
    'A cloud hosting symbol and a generic user-managed computer or server symbol each contain a Klex Bot and its own data folder. Chats and memory stay in that Bot’s data directory: in the hosted environment for Cloud-hosted Bots, and in the self-hosted environment for self-hosted Bots, including when enrolled in Klex Cloud. The symbols illustrate location, not infrastructure, access boundaries, transfer, sync, backup or security guarantees.';
  const text = (x, y, label, heading = false, environment = '') =>
    '<text x="' +
    x +
    '" y="' +
    y +
    '" text-anchor="middle" font-size="' +
    (heading ? 36 : 32) +
    '" class="label"' +
    (heading
      ? ' data-heading="true"'
      : ' data-environment="' + environment + '"') +
    '>' +
    label +
    '</text>';
  const cloud = (x, y) =>
    '<path id="cloud-environment" data-environment-outline="cloud" transform="translate(' +
    x +
    ' ' +
    y +
    ')" d="M110 300C50 300 10 267 10 213C10 160 48 122 96 117C96 62 137 22 194 22C236 22 270 43 288 76C307 59 333 50 360 50C413 50 455 89 460 140C490 156 508 182 508 218C508 264 471 300 424 300Z" fill="' +
    C.scope +
    '" stroke="' +
    C.accent +
    '" stroke-width="3.5" stroke-linejoin="round"/>';
  const server = (x, y) =>
    '<g aria-hidden="true"><rect id="self-environment" data-environment-outline="self" x="' +
    x +
    '" y="' +
    y +
    '" width="416" height="276" rx="20" fill="' +
    C.scope +
    '" stroke="' +
    C.accent +
    '" stroke-width="3.5"/><path d="M' +
    (x + 24) +
    ' ' +
    (y + 230) +
    'H' +
    (x + 392) +
    'M' +
    (x + 40) +
    ' ' +
    (y + 252) +
    'h22m14 0h22m14 0h22M' +
    (x + 56) +
    ' ' +
    (y + 276) +
    'v26h54v-26m196 0v26h54v-26" fill="none" stroke="' +
    C.accent +
    '" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="' +
    (x + 374) +
    '" cy="' +
    (y + 252) +
    '" r="4" fill="' +
    C.accent +
    '"/></g>';
  const contents = (cx, y, labelY, env) =>
    '<image data-content-icon="bot" data-environment="' +
    env +
    '" href="' +
    logoURI +
    '" x="' +
    (cx - 142) +
    '" y="' +
    y +
    '" width="64" height="64"/>' +
    text(cx - 110, labelY, 'Bot', false, env) +
    '<g data-content-icon="data" data-environment="' +
    env +
    '" class="icon" transform="translate(' +
    (cx + 78) +
    ' ' +
    (y + 4) +
    ') scale(.8888889)"><path fill="' +
    C.canvas +
    '" d="M0 8a6 6 0 0 1 6-6h22l10 10h28a6 6 0 0 1 6 6v42a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6Z"/><path d="M17 32h36M17 45h26"/></g>' +
    text(cx + 110, labelY, 'Data', false, env);
  const start = (w, h) => {
    const id = 'data-location-' + w,
      step = w === 640 ? 40 : 32;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      w +
      '" height="' +
      h +
      '" viewBox="0 0 ' +
      w +
      ' ' +
      h +
      '" role="img" aria-labelledby="' +
      id +
      '-title ' +
      id +
      '-description"><title id="' +
      id +
      '-title">Where each Bot’s data lives</title><desc id="' +
      id +
      '-description">' +
      alt +
      '</desc><style>' +
      css +
      '</style><defs><pattern id="' +
      id +
      '-grid" width="' +
      step +
      '" height="' +
      step +
      '" patternUnits="userSpaceOnUse"><path d="M' +
      step +
      ' 0H0V' +
      step +
      '" fill="none" stroke="' +
      C.grid +
      '" stroke-opacity=".35" stroke-width="1"/></pattern></defs><rect width="' +
      w +
      '" height="' +
      h +
      '" fill="' +
      C.canvas +
      '"/><rect data-background-grid="true" width="' +
      w +
      '" height="' +
      h +
      '" fill="url(#' +
      id +
      '-grid)"/>'
    );
  };
  const wide =
    start(1200, 480) +
    text(320, 62, 'Cloud-hosted', true) +
    text(920, 62, 'Self-hosted', true) +
    cloud(66, 100) +
    server(712, 124) +
    contents(320, 235, 340, 'cloud') +
    contents(920, 235, 340, 'self') +
    '</svg>';
  const compact =
    start(640, 820) +
    text(320, 52, 'Cloud-hosted', true) +
    cloud(66, 80) +
    contents(320, 215, 320, 'cloud') +
    text(320, 448, 'Self-hosted', true) +
    server(112, 480) +
    contents(320, 591, 696, 'self') +
    '</svg>';
  const layouts = [
      { name: 'data-wide', svg: wide, w: 1200, h: 480, embed: 720 },
      { name: 'data-compact', svg: compact, w: 640, h: 820, embed: 320 },
    ],
    files = [];
  for (const l of layouts) {
    await fs.writeFile(kit + '/' + l.name + '.svg', l.svg);
    await page.setViewportSize({ width: l.w, height: l.h });
    await page.setContent(
      '<style>html,body{margin:0}svg{display:block}</style>' + l.svg,
    );
    await page.evaluate(() =>
      Promise.all([...document.fonts].map((f) => f.load())),
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(80);
    const qa = await page.evaluate(() => {
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const texts = [...document.querySelectorAll('text')].map((e) => ({
        text: e.textContent,
        heading: e.hasAttribute('data-heading'),
        rect: rect(e),
      }));
      const nodes = [
        ...document.querySelectorAll('[data-environment]:not(text)'),
      ];
      const containment = nodes.map((e) => {
        const r = rect(e),
          outline = document.getElementById(
            e.dataset.environment === 'cloud'
              ? 'cloud-environment'
              : 'self-environment',
          ),
          inv = outline.getScreenCTM().inverse();
        const points = [
          [r.x - 8, r.y - 8],
          [r.right + 8, r.y - 8],
          [r.x - 8, r.bottom + 8],
          [r.right + 8, r.bottom + 8],
        ];
        return {
          icon: e.dataset.contentIcon,
          environment: e.dataset.environment,
          insideWith8pxClearance: points.every(([x, y]) =>
            outline.isPointInFill(new DOMPoint(x, y).matrixTransform(inv)),
          ),
          rect: r,
        };
      });
      const labelContainment = [
        ...document.querySelectorAll('text[data-environment]'),
      ].map((e) => {
        const r = rect(e),
          o = document.getElementById(
            e.dataset.environment === 'cloud'
              ? 'cloud-environment'
              : 'self-environment',
          ),
          inv = o.getScreenCTM().inverse();
        return {
          text: e.textContent,
          environment: e.dataset.environment,
          insideWith8pxClearance: [
            [r.x - 8, r.y - 8],
            [r.right + 8, r.y - 8],
            [r.x - 8, r.bottom + 8],
            [r.right + 8, r.bottom + 8],
          ].every(([x, y]) =>
            o.isPointInFill(new DOMPoint(x, y).matrixTransform(inv)),
          ),
        };
      });
      return {
        fontLoaded: document.fonts.check('550 32px Geist'),
        texts,
        containment,
        labelContainment,
        environmentOutlines: document.querySelectorAll(
          '[data-environment-outline]',
        ).length,
        arrows: document.querySelectorAll('[marker-end],[marker-start]').length,
        routeCount: document.querySelectorAll('.route,.internal').length,
      };
    });
    if (errors.length || !qa.fontLoaded) throw Error('Runtime or font error');
    if (
      qa.texts.length !== 6 ||
      qa.environmentOutlines !== 2 ||
      qa.routeCount ||
      qa.arrows
    )
      throw Error('Unexpected content/topology');
    if (
      qa.containment.some((x) => !x.insideWith8pxClearance) ||
      qa.labelContainment.some((x) => !x.insideWith8pxClearance)
    )
      throw Error('Environment clearance ' + JSON.stringify(qa));
    for (const t of qa.texts)
      if (
        t.rect.x < 0 ||
        t.rect.right > l.w ||
        t.rect.y < 0 ||
        t.rect.bottom > l.h
      )
        throw Error('Text out of canvas');
    const png = l.name + '@2x.png';
    await page.screenshot({ path: kit + '/' + png });
    const b = await fs.readFile(kit + '/' + png),
      m = await sharp(b).metadata();
    if (
      m.width !== l.w * 2 ||
      m.height !== l.h * 2 ||
      !(await sharp(b).stats()).isOpaque
    )
      throw Error('PNG export');
    files.push({
      name: l.name,
      svg: l.name + '.svg',
      png,
      viewBox: [l.w, l.h],
      bytes: b.length,
      sha256: crypto.createHash('sha256').update(b).digest('hex'),
      qa,
    });
  }
  const previewPage = await browser.newPage({
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await previewPage.context().setOffline(true);
  for (const l of layouts) {
    await previewPage.setViewportSize({
      width: l.embed,
      height: Math.ceil((l.h * l.embed) / l.w),
    });
    for (const headings of [true, false]) {
      let svg = l.svg;
      if (!headings)
        svg = svg.replaceAll(
          /<text[^>]*data-heading="true"[^>]*>.*?<\/text>/g,
          '',
        );
      await previewPage.setContent(
        '<style>html,body{margin:0}img{display:block;width:100%;height:auto}</style><img src="data:image/svg+xml;base64,' +
          Buffer.from(svg).toString('base64') +
          '">',
      );
      await previewPage.locator('img').evaluate((i) => i.decode());
      await previewPage.screenshot({
        path:
          kit +
          '/' +
          l.name +
          (headings ? '-preview' : '-heading-free-proof') +
          '.png',
      });
    }
  }
  await previewPage.close();
  await fs.writeFile(
    kit + '/tokens.json',
    JSON.stringify(
      {
        source: 'sources/stagewise-ui/package/src/styles/palette.css',
        verifiedBeforeRender: true,
        colors,
        contrastQA,
        typography: {
          family: 'Geist',
          labelSize: 32,
          headingSize: 36,
          weight: 550,
        },
        semantics:
          'Different hosting pictograms; identical own Bot/data contents. Enclosures are location pictograms, not permission boundaries. No routes, sync or transfer.',
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    kit + '/manifest.json',
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: {
          commit: '18b837c568c613e54ac5819d47f818a47a2eaded',
          path: 'apps/docs/docs/bot/concepts/10-data-directory.mdx',
          theme: 'apps/docs/theme.css',
        },
        visibleLabels: [
          'Cloud-hosted',
          'Self-hosted',
          'Bot',
          'Data',
          'Bot',
          'Data',
        ],
        alt,
        files,
        contrastQA,
        visualReview: {
          directInspectionCompleted: false,
          status: 'Pending actual PNG inspection; automated QA only.',
        },
        integrationOwner: 'Knuth',
        integration: {
          switch: '640px container width',
          dimensionsChangedFromV2: { wide: [960, 360], compact: [640, 648] },
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ files: files.map(({ qa, ...f }) => f), contrastQA }),
  );
} finally {
  await browser.close();
}
