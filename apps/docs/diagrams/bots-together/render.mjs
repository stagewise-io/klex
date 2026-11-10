import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';

const kit = path.dirname(fileURLToPath(import.meta.url));
process.env.LD_LIBRARY_PATH = [
  process.env.KLEX_SYSROOT ||
    '/workspace/marketing-studio/.local/sysroot/lib/x86_64-linux-gnu',
  '/workspace/marketing-studio/.local/sysroot/usr/lib/x86_64-linux-gnu',
  process.env.LD_LIBRARY_PATH,
]
  .filter(Boolean)
  .join(':');
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
    'Two Klex Bots connect separately to one shared conversation. Each needs a messaging connection and an account with access. People can participate in the same conversation.';
  const text = (x, y, label, anchor = 'start', parent = '') =>
    '<text x="' +
    x +
    '" y="' +
    y +
    '" font-size="32" class="label" text-anchor="' +
    anchor +
    '"' +
    (parent ? ' data-box="' + parent + '"' : '') +
    '>' +
    label +
    '</text>';
  const box = (id, x, y, w, h, conversation = false) =>
    '<rect id="' +
    id +
    '" x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" rx="' +
    (conversation ? 28 : 18) +
    '" ' +
    (conversation
      ? 'fill="' + C.scope + '" stroke="' + C.scopeBorder + '" stroke-width="2"'
      : 'class="card"') +
    '/>';
  const bot = (id, x, y, w, label) =>
    box(id, x, y, w, 120) +
    '<image href="' +
    logoURI +
    '" x="' +
    (x + 24) +
    '" y="' +
    (y + 28) +
    '" width="64" height="64"/>' +
    text(x + 114, y + 71, label, 'start', id);
  const person = (x, y) =>
    box('people', x, y, 280, 88) +
    '<g class="icon" transform="translate(' +
    (x + 28) +
    ' ' +
    (y + 21) +
    ')"><circle cx="21" cy="11" r="9"/><path d="M4 44v-6c0-19 34-19 34 0v6"/></g>' +
    text(x + 92, y + 55, 'People', 'start', 'people');
  const chat = (x, y) =>
    '<g class="icon" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><path d="M7 5h58a9 9 0 0 1 9 9v27a9 9 0 0 1-9 9H29L15 62V50H7a7 7 0 0 1-7-7V12a7 7 0 0 1 7-7Z"/><path d="M78 23h3a7 7 0 0 1 7 7v31a7 7 0 0 1-7 7h-9v11L59 68H42a7 7 0 0 1-7-7v-5"/></g>';
  const start = (w, h) => {
    const id = 'together-' + w,
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
      '-title">Bots coordinate through a shared conversation</title><desc id="' +
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
  let wide =
    start(1200, 520) +
    '<path id="bot-a-connection" data-from="bot-a" data-to="conversation" class="route" d="M270 220H400"/><path id="bot-b-connection" data-from="bot-b" data-to="conversation" class="route" d="M930 220H800"/><path id="people-participation" data-from="people" data-to="conversation" class="internal" d="M600 392V328"/>';
  wide +=
    bot('bot-a', 40, 160, 230, 'Bot A') +
    bot('bot-b', 930, 160, 230, 'Bot B') +
    box('conversation', 400, 112, 400, 216, true) +
    text(600, 172, 'Shared conversation', 'middle', 'conversation') +
    chat(556, 206) +
    person(460, 392) +
    '</svg>';
  let compact =
    start(640, 720) +
    '<path id="bot-a-connection" data-from="bot-a" data-to="conversation" class="route" d="M170 168V196C170 224 200 224 200 252V280"/><path id="bot-b-connection" data-from="bot-b" data-to="conversation" class="route" d="M470 168V196C470 224 440 224 440 252V280"/><path id="people-participation" data-from="people" data-to="conversation" class="internal" d="M320 584V512"/>';
  compact +=
    bot('bot-a', 40, 48, 260, 'Bot A') +
    bot('bot-b', 340, 48, 260, 'Bot B') +
    box('conversation', 80, 280, 480, 232, true) +
    text(320, 342, 'Shared conversation', 'middle', 'conversation') +
    chat(276, 382) +
    person(180, 584) +
    '</svg>';
  const layouts = [
      { name: 'bots-together-wide', svg: wide, w: 1200, h: 520, embed: 720 },
      {
        name: 'bots-together-compact',
        svg: compact,
        w: 640,
        h: 720,
        embed: 320,
      },
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
    await page.waitForTimeout(100);
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
      const nodes = Object.fromEntries(
        ['bot-a', 'bot-b', 'conversation', 'people'].map((id) => [
          id,
          rect(document.getElementById(id)),
        ]),
      );
      const texts = [...document.querySelectorAll('text')].map((e) => ({
        text: e.textContent,
        rect: rect(e),
        box: nodes[e.dataset.box],
      }));
      const connections = [...document.querySelectorAll('path[data-from]')].map(
        (p) => {
          const n = p.getTotalLength(),
            start = p.getPointAtLength(0),
            end = p.getPointAtLength(n);
          return {
            id: p.id,
            from: p.dataset.from,
            to: p.dataset.to,
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
            hasArrow:
              p.hasAttribute('marker-end') || p.hasAttribute('marker-start'),
          };
        },
      );
      return {
        loaded: document.fonts.check('550 32px Geist'),
        fonts: [...document.fonts].map((f) => ({
          family: f.family,
          status: f.status,
        })),
        nodes,
        texts,
        connections,
      };
    });
    if (
      errors.length ||
      !qa.loaded ||
      qa.fonts.some((f) => f.status !== 'loaded')
    )
      throw Error('Runtime/font check');
    if (
      qa.texts.length !== 4 ||
      qa.texts
        .map((t) => t.text)
        .join(' ')
        .split(' ').length !== 7
    )
      throw Error('Unexpected text density');
    const inside = (p, r, pad = 0) =>
      p.x > r.x + pad &&
      p.x < r.right - pad &&
      p.y > r.y + pad &&
      p.y < r.bottom - pad;
    for (const t of qa.texts) {
      if (
        t.rect.x < 0 ||
        t.rect.right > l.w ||
        t.rect.y < 0 ||
        t.rect.bottom > l.h
      )
        throw Error('Out of canvas');
      if (
        t.rect.x < t.box.x + 16 ||
        t.rect.right > t.box.right - 16 ||
        t.rect.y < t.box.y + 16 ||
        t.rect.bottom > t.box.bottom - 16
      )
        throw Error('Text/card clearance ' + t.text);
    }
    if (
      qa.connections.length !== 3 ||
      qa.connections.some((c) => c.to !== 'conversation' || c.hasArrow) ||
      qa.connections.filter((c) => c.from.startsWith('bot-')).length !== 2
    )
      throw Error('Connection topology');
    for (const c of qa.connections) {
      for (const [p, r] of [
        [c.start, qa.nodes[c.from]],
        [c.end, qa.nodes[c.to]],
      ])
        if (
          inside(p, r, 2) ||
          !inside(p, {
            x: r.x - 2,
            y: r.y - 2,
            right: r.right + 2,
            bottom: r.bottom + 2,
          })
        )
          throw Error('Endpoint does not meet node boundary ' + c.id);
    }
    const png = l.name + '@2x.png';
    await page.screenshot({ path: kit + '/' + png });
    const bytes = await fs.readFile(kit + '/' + png),
      meta = await sharp(bytes).metadata();
    if (
      meta.width !== l.w * 2 ||
      meta.height !== l.h * 2 ||
      !(await sharp(bytes).stats()).isOpaque
    )
      throw Error('PNG export');
    files.push({
      name: l.name,
      svg: l.name + '.svg',
      png,
      viewBox: [l.w, l.h],
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      qa,
    });
  }
  const previewPage = await browser.newPage({
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await previewPage.context().setOffline(true);
  for (const l of layouts) {
    const height = (l.h * l.embed) / l.w;
    await previewPage.setViewportSize({
      width: l.embed,
      height: Math.ceil(height),
    });
    await previewPage.setContent(
      '<style>html,body{margin:0}img{display:block;width:100%;height:auto}</style><img src="data:image/svg+xml;base64,' +
        Buffer.from(l.svg).toString('base64') +
        '">',
    );
    await previewPage.locator('img').evaluate((i) => i.decode());
    await previewPage.screenshot({ path: kit + '/' + l.name + '-preview.png' });
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
        typography: { family: 'Geist', labelSize: 32, weight: 550 },
        grid: {
          wideStep: 32,
          compactStep: 40,
          opacity: 0.35,
          continuous: true,
          semantic: false,
        },
        meaning: {
          bluePanel:
            'Shared conversation, not shared Bot memory or environment',
          bluePaths:
            'Separate messaging connections; not access grants or directed execution',
          neutralPath: 'People may participate; not an MCP claim',
        },
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
          commit: '7cf710c442f3c64b0e2b094fc4691c8889b24cc7',
          path: 'apps/docs/docs/guides/(collaboration)/bot-collaboration.mdx',
          matchesEarlierReference: 'b6546653601dffa5e6f6c78ced8c627e2ac274fd',
          confirmedByKnuth: '1794316735.650839',
        },
        visibleLabels: ['Bot A', 'Bot B', 'Shared conversation', 'People'],
        visibleWordCount: 7,
        alt,
        files,
        contrastQA,
        visualReview: {
          status:
            'Pending direct review of actual local renders; generated proofs are automated-only.',
          directInspectionCompleted: false,
        },
        integrationOwner: 'Knuth',
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    kit + '/manual-review.json',
    JSON.stringify(
      {
        status: 'Pending direct visual inspection',
        directInspectionCompleted: false,
        scope:
          'None yet; automated checks do not constitute direct visual sign-off.',
        requestedNextStep:
          'Knuth integrates and shares actual local desktop/mobile renders for scoped review; no individual Glenn approval gate.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      files: files.map(({ qa, ...f }) => f),
      wordCount: 7,
      contrastQA,
    }),
  );
} finally {
  await browser.close();
}
