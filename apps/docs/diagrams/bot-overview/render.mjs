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
  internal: '--color-base-350',
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
    mcpLabel: contrast('accent', 'canvas'),
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
    mcpLabelOnGrid: onGrid('accent'),
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
    ';stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;mask:url(#mcp-label-gaps)}.internal{fill:none;stroke:' +
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
  const text = (x, y, s, content, cls = 'label', anchor = 'start', box = '') =>
    '<text x="' +
    x +
    '" y="' +
    y +
    '" font-size="' +
    s +
    '" class="' +
    cls +
    '" text-anchor="' +
    anchor +
    '"' +
    (box ? ' data-box="' + box + '"' : '') +
    '>' +
    content +
    '</text>';
  const box = (id, x, y, w, h, scope = false) =>
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
    (scope ? 28 : 18) +
    '" ' +
    (scope
      ? 'fill="' + C.scope + '" stroke="' + C.scopeBorder + '" stroke-width="2"'
      : 'class="card"') +
    '/>';
  const icon = (kind, x, y) => {
    const paths = {
      memory:
        '<ellipse cx="22" cy="8" rx="17" ry="6"/><path d="M5 8v27c0 8 34 8 34 0V8M5 21c0 8 34 8 34 0"/>',
      computer:
        '<rect x="2" y="3" width="40" height="28" rx="3"/><path d="M22 31v10M11 41h22"/>',
      app: '<rect x="2" y="3" width="40" height="38" rx="6"/><path d="M2 15h40M10 9h1M17 9h1"/>',
    };
    return (
      '<g class="icon" transform="translate(' +
      x +
      ' ' +
      y +
      ')">' +
      paths[kind] +
      '</g>'
    );
  };
  const badge = (x, y) => text(x + 41, y + 9, 26, 'MCP', 'mcp', 'middle');
  const alt =
    'A Klex Bot and its memory are inside the Bot environment, which runs the Bot and manages memory. Memory currently holds skills and learnings. Separate MCP connections link the Bot to a connected computer and a connected app outside the Bot environment, where its work happens. Lines show connections, not the direction of data flow.';
  const grid = (w, h) => {
    const step = w === 640 ? 40 : 32,
      labels =
        w === 640
          ? [
              [309, 650],
              [507, 690],
            ]
          : [
              [695, 280],
              [695, 480],
            ],
      gaps = labels
        .map(
          ([x, y]) =>
            '<rect x="' +
            x +
            '" y="' +
            (y - 24) +
            '" width="82" height="46" rx="12" fill="black"/>',
        )
        .join('');
    return (
      '<defs><pattern id="subtle-grid" width="' +
      step +
      '" height="' +
      step +
      '" patternUnits="userSpaceOnUse"><path d="M' +
      step +
      ' 0H0V' +
      step +
      '" fill="none" stroke="' +
      C.grid +
      '" stroke-opacity=".35" stroke-width="1"/></pattern><mask id="mcp-label-gaps" maskUnits="userSpaceOnUse" x="0" y="0" width="' +
      w +
      '" height="' +
      h +
      '"><rect width="' +
      w +
      '" height="' +
      h +
      '" fill="white"/>' +
      gaps +
      '</mask></defs><rect data-background-grid="true" width="' +
      w +
      '" height="' +
      h +
      '" fill="url(#subtle-grid)"/>'
    );
  };
  const start = (w, h) =>
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    w +
    '" height="' +
    h +
    '" viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" role="img" aria-labelledby="diagram-title diagram-description"><title id="diagram-title">How Klex Bots work: overview</title><desc id="diagram-description">' +
    alt +
    '</desc><style>' +
    css +
    '</style><rect width="' +
    w +
    '" height="' +
    h +
    '" fill="' +
    C.canvas +
    '"/>' +
    grid(w, h);
  let wide =
    start(1200, 640) +
    box('environment', 40, 80, 510, 520, true) +
    text(76, 134, 30, 'Bot environment', 'label', 'start', 'environment') +
    text(
      76,
      174,
      24,
      'Runs the Bot · manages memory',
      'helper',
      'start',
      'environment',
    );
  wide +=
    '<path class="internal" d="M286 391V442"/><path class="route" d="M480 302C600 302 610 280 690 280H810"/><path class="route" d="M480 346C620 346 600 480 690 480H810"/>';
  wide +=
    box('bot', 94, 255, 386, 136) +
    '<image href="' +
    logoURI +
    '" x="118" y="290" width="64" height="64"/>' +
    text(206, 313, 30, 'Klex Bot', 'label', 'start', 'bot') +
    text(206, 349, 24, 'Own identity', 'helper', 'start', 'bot');
  wide +=
    box('memory', 94, 442, 386, 115) +
    icon('memory', 120, 477) +
    text(184, 486, 28, 'Memory', 'label', 'start', 'memory') +
    text(184, 523, 24, 'Skills &amp; learnings', 'helper', 'start', 'memory');
  wide +=
    text(810, 134, 28, 'Work happens here') +
    text(810, 174, 24, 'Outside the Bot environment', 'helper');
  wide +=
    box('computer', 810, 220, 350, 120) +
    icon('computer', 838, 258) +
    text(907, 269, 28, 'Connected', 'label', 'start', 'computer') +
    text(907, 304, 28, 'computer', 'label', 'start', 'computer');
  wide +=
    box('app', 810, 420, 350, 120) +
    icon('app', 838, 458) +
    text(907, 469, 28, 'Connected', 'label', 'start', 'app') +
    text(907, 504, 28, 'app', 'label', 'start', 'app') +
    badge(695, 280) +
    badge(695, 480) +
    '</svg>';
  let mobile =
    start(640, 970) +
    box('environment', 28, 40, 544, 500, true) +
    text(68, 102, 32, 'Bot environment', 'label', 'start', 'environment') +
    text(
      68,
      148,
      26,
      'Runs the Bot · manages memory',
      'helper',
      'start',
      'environment',
    );
  mobile +=
    '<path class="internal" d="M300 326V386"/><path class="route" d="M520 292H576C592 292 604 304 604 320V618C604 638 592 650 572 650H202C184 650 170 664 170 682V750"/><path class="route" d="M520 250H596C612 250 624 262 624 278V658C624 678 612 690 592 690H502C484 690 470 704 470 722V750"/>';
  mobile +=
    box('bot', 80, 190, 440, 136) +
    '<image href="' +
    logoURI +
    '" x="108" y="226" width="64" height="64"/>' +
    text(202, 246, 32, 'Klex Bot', 'label', 'start', 'bot') +
    text(202, 286, 28, 'Own identity', 'helper', 'start', 'bot');
  mobile +=
    box('memory', 80, 386, 440, 116) +
    icon('memory', 112, 423) +
    text(184, 434, 30, 'Memory', 'label', 'start', 'memory') +
    text(184, 475, 28, 'Skills &amp; learnings', 'helper', 'start', 'memory');
  mobile +=
    text(320, 600, 30, 'Work happens here', 'label', 'middle') +
    box('computer', 40, 750, 260, 180) +
    icon('computer', 148, 774) +
    text(170, 855, 28, 'Connected', 'label', 'middle', 'computer') +
    text(170, 894, 28, 'computer', 'label', 'middle', 'computer') +
    box('app', 340, 750, 260, 180) +
    icon('app', 448, 774) +
    text(470, 855, 28, 'Connected', 'label', 'middle', 'app') +
    text(470, 894, 28, 'app', 'label', 'middle', 'app') +
    badge(309, 650) +
    badge(507, 690) +
    '</svg>';
  const plain = (s) => s.replace(/<rect data-background-grid[^>]*\/>/, '');
  const layouts = [
      { name: 'overview-wide', svg: wide, w: 1200, h: 640, embed: 720 },
      { name: 'overview-mobile', svg: mobile, w: 640, h: 970, embed: 320 },
      {
        name: 'overview-wide-no-grid',
        svg: plain(wide),
        w: 1200,
        h: 640,
        embed: 720,
      },
      {
        name: 'overview-mobile-no-grid',
        svg: plain(mobile),
        w: 640,
        h: 970,
        embed: 320,
      },
    ],
    files = [];
  for (const l of layouts) {
    await fs.writeFile(kit + '/' + l.name + '.svg', l.svg);
    await page.setViewportSize({ width: l.w, height: l.h });
    await page.setContent(
      '<style>html,body{margin:0;padding:0;background:' +
        C.canvas +
        '}svg{display:block}</style>' +
        l.svg,
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
      return {
        fonts: [...document.fonts].map((f) => ({
          family: f.family,
          status: f.status,
        })),
        texts: [...document.querySelectorAll('text')].map((e) => ({
          text: e.textContent,
          rect: rect(e),
          box: e.dataset.box
            ? rect(document.getElementById(e.dataset.box))
            : null,
        })),
        links: document.querySelectorAll('.route').length,
        boundary: rect(document.getElementById('environment')),
        bot: rect(document.getElementById('bot')),
        memory: rect(document.getElementById('memory')),
        computer: rect(document.getElementById('computer')),
        app: rect(document.getElementById('app')),
        loaded: document.fonts.check('500 30px Geist'),
      };
    });
    if (
      errors.length ||
      !qa.loaded ||
      qa.fonts.some((f) => f.status !== 'loaded') ||
      qa.links !== 2
    )
      throw Error('Runtime/font/link check');
    for (const t of qa.texts) {
      if (
        t.rect.x < 0 ||
        t.rect.right > l.w ||
        t.rect.y < 0 ||
        t.rect.bottom > l.h
      )
        throw Error('Out of canvas ' + t.text);
      if (
        t.box &&
        (t.rect.x < t.box.x + 10 ||
          t.rect.right > t.box.right - 10 ||
          t.rect.y < t.box.y + 10 ||
          t.rect.bottom > t.box.bottom - 10)
      )
        throw Error('Text outside card ' + t.text);
    }
    const E = qa.boundary;
    for (const b of [qa.bot, qa.memory])
      if (b.x < E.x || b.right > E.right || b.y < E.y || b.bottom > E.bottom)
        throw Error('Internal node not contained');
    for (const b of [qa.computer, qa.app])
      if (!(b.x >= E.right || b.y >= E.bottom))
        throw Error('External node inside environment');
    const png = kit + '/' + l.name + '@2x.png';
    await page.screenshot({ path: png });
    const bytes = await fs.readFile(png),
      meta = await sharp(bytes).metadata();
    if (
      meta.width !== l.w * 2 ||
      meta.height !== l.h * 2 ||
      !(await sharp(bytes).stats()).isOpaque
    )
      throw Error('PNG check');
    files.push({
      name: l.name,
      svg: l.name + '.svg',
      png: l.name + '@2x.png',
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      qa,
    });
    await page.setViewportSize({
      width: l.embed,
      height: Math.round((l.h * l.embed) / l.w),
    });
    await page.addStyleTag({
      content: 'svg{width:' + l.embed + 'px;height:auto}',
    });
    await page.screenshot({ path: kit + '/' + l.name + '-embed-preview.png' });
  }
  await fs.writeFile(
    kit + '/tokens.json',
    JSON.stringify(
      {
        source: 'stagewise-ui/package/src/styles/palette.css',
        verifiedBeforeRender: true,
        colors,
        contrastQA,
        typography: {
          family: 'Geist',
          wideLabel: 28,
          wideHelper: 24,
          mobileLabel: 28,
          mobileHelper: 26,
        },
        meaning: {
          scope: 'Bot runtime and memory, not a workspace or security boundary',
          grid: {
            token: roles.grid,
            opacity: 0.35,
            wideStep: 32,
            mobileStep: 40,
            semantic: false,
          },
          blueLines: 'Smooth MCP connectivity; not data-flow direction',
          neutralLine: 'Internal Bot-memory relationship; not MCP',
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
        source:
          'https://github.com/stagewise-io/klex/blob/8f320838ecc26c66a50119fa1640535308d21bec/apps/docs/docs/bot/concepts/01-how-bots-work.mdx',
        alt,
        files,
        contrastQA,
        visualReview: { status: 'pending' },
        approval:
          'Proposal for Knuth and Glenn; not approved or added to docs.',
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
