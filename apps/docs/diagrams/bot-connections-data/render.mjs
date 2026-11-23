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
  if (!palette.includes(t + ':')) throw Error('Undefined token ' + t);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 840 },
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
        if (v === 'rgba(0, 0, 0, 0)') throw Error(token);
        const c = document
          .createElement('canvas')
          .getContext('2d', { colorSpace: 'srgb' });
        c.fillStyle = v;
        c.fillRect(0, 0, 1, 1);
        const rgb = [...c.getImageData(0, 0, 1, 1).data].slice(0, 3);
        result[role] = {
          token,
          hex: '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''),
          rgb,
        };
        e.remove();
      }
      return result;
    }, roles),
    C = Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, v.hex]));
  const lum = (rgb) =>
      rgb
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0),
    ratio = (a, b) =>
      (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05),
    gridBG = colors.canvas.rgb.map((v, i) =>
      Math.floor(v * 0.65 + colors.grid.rgb[i] * 0.35),
    ),
    contrastQA = {};
  for (const role of ['ink', 'muted', 'accent'])
    for (const [name, bg] of [
      ['canvas', colors.canvas.rgb],
      ['grid', gridBG],
    ])
      contrastQA[role + 'On' + name] = ratio(colors[role].rgb, bg);
  contrastQA.helperOnScope = ratio(colors.muted.rgb, colors.scope.rgb);
  if (Object.values(contrastQA).some((v) => v < 4.5))
    throw Error('Contrast failed');
  const css =
    '@font-face{font-family:Geist;src:url(data:font/woff2;base64,' +
    font.toString('base64') +
    ') format("woff2");font-weight:100 900;font-display:block}text{font-family:Geist,sans-serif;font-synthesis:none;fill:' +
    C.ink +
    '}.label{font-weight:550}.helper{fill:' +
    C.muted +
    ';font-weight:400}.route{fill:none;stroke:' +
    C.accent +
    ';stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}.relation{fill:none;stroke:' +
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
  const esc = (s) =>
      String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    T = (x, y, s, t, cls = 'label', anchor = 'start', box = '') =>
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
      esc(t) +
      '</text>',
    B = (id, x, y, w, h, scope = false, parent = '') =>
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
      '"' +
      (parent ? ' data-parent="' + parent + '"' : '') +
      ' ' +
      (scope
        ? 'fill="' +
          C.scope +
          '" stroke="' +
          C.scopeBorder +
          '" stroke-width="2"'
        : 'class="card"') +
      '/>',
    L = (d, cls = 'route') => '<path class="' + cls + '" d="' + d + '"/>',
    logoURI = 'data:image/svg+xml;base64,' + logo.toString('base64'),
    mark = (x, y, s = 48) =>
      '<image href="' +
      logoURI +
      '" x="' +
      x +
      '" y="' +
      y +
      '" width="' +
      s +
      '" height="' +
      s +
      '"/>';
  const appIcon = (x, y) =>
    '<g class="icon" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><rect x="2" y="3" width="40" height="38" rx="6"/><path d="M2 15h40M10 9h1M17 9h1"/></g>';
  const start = (slug, w, h, title, alt) => {
    const step = w === 640 ? 40 : 32;
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
      slug +
      '-title ' +
      slug +
      '-desc"><title id="' +
      slug +
      '-title">' +
      esc(title) +
      '</title><desc id="' +
      slug +
      '-desc">' +
      esc(alt) +
      '</desc><style>' +
      css +
      '</style><defs><pattern id="' +
      slug +
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
      slug +
      '-grid)"/>'
    );
  };
  const alts = {
    hosting:
      'Cloud-hosted and self-hosted Bot environments each contain a Bot and its own data directory. Chats and memory are stored in that directory. The self-hosted directory remains in the self-hosted environment even if the Bot is enrolled in Klex Cloud. The diagram shows data location, not a backup or security guarantee.',
    mcp: 'A Klex Bot connects to an external app through MCP. Inside the app, the Bot account is shown separately: access depends on that account and its permissions in the app, not on the connection alone. The MCP server determines which capabilities it exposes. The line shows a connection, not a workflow or data-flow direction.',
  };
  const person = (x, y) =>
    '<g class="icon" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><circle cx="24" cy="14" r="10"/><path d="M4 52v-8c0-10 9-18 20-18s20 8 20 18v8"/></g>';
  const folder = (x, y) =>
    '<g class="icon" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><path d="M0 10V2h24l10 10h30v44H0V10h64"/></g>';
  const layouts = [];
  const add = (name, w, h, svg, subject) =>
    layouts.push({
      name,
      w,
      h,
      svg: svg + '</svg>',
      subject,
      embed: w === 640 ? 320 : 720,
      alt: alts[subject],
    });
  let s = start(
    'mcp-wide',
    960,
    360,
    'MCP connection and app account',
    alts.mcp,
  );
  s +=
    L('M256 196C360 196 448 196 552 196') +
    T(404, 168, 28, 'MCP', 'mcp', 'middle') +
    B('mcp-bot', 48, 104, 208, 184) +
    mark(128, 128, 48) +
    T(152, 252, 30, 'Bot', 'label', 'middle', 'mcp-bot') +
    B('app', 552, 32, 360, 296) +
    appIcon(580, 56) +
    T(644, 91, 30, 'App', 'label', 'start', 'app') +
    B('account', 584, 136, 296, 160, true, 'app') +
    person(708, 155) +
    T(732, 264, 28, 'Bot account', 'label', 'middle', 'account');
  add('mcp-wide', 960, 360, s, 'mcp');
  s = start(
    'mcp-compact',
    640,
    584,
    'MCP connection and app account',
    alts.mcp,
  );
  s +=
    L('M232 112H472C528 112 560 136 560 192V272') +
    T(400, 82, 30, 'MCP', 'mcp', 'middle') +
    B('compact-mcp-bot', 32, 32, 200, 160) +
    mark(108, 56, 48) +
    T(132, 156, 32, 'Bot', 'label', 'middle', 'compact-mcp-bot') +
    B('compact-app', 32, 272, 576, 280) +
    appIcon(64, 300) +
    T(132, 338, 32, 'App', 'label', 'start', 'compact-app') +
    B('compact-account', 64, 384, 512, 136, true, 'compact-app') +
    person(96, 423) +
    T(176, 464, 32, 'Bot account', 'label', 'start', 'compact-account');
  add('mcp-compact', 640, 584, s, 'mcp');
  s = start('data-wide', 960, 360, 'Where Bot data lives', alts.hosting);
  for (const i of [0, 1]) {
    const x = 32 + i * 464,
      id = 'data-' + i;
    s +=
      B(id, x, 24, 432, 312, true) +
      T(
        x + 24,
        74,
        30,
        i ? 'Self-hosted' : 'Cloud-hosted',
        'label',
        'start',
        id,
      ) +
      B(id + '-bot', x + 24, 108, 152, 200, false, id) +
      mark(x + 76, 138, 48) +
      T(x + 100, 264, 28, 'Bot', 'label', 'middle', id + '-bot') +
      B(id + '-dir', x + 224, 108, 184, 200, false, id) +
      folder(x + 284, 148) +
      T(x + 316, 264, 28, 'Data', 'label', 'middle', id + '-dir') +
      L('M' + (x + 176) + ' 208H' + (x + 224), 'relation');
  }
  add('data-wide', 960, 360, s, 'hosting');
  s = start('data-compact', 640, 648, 'Where Bot data lives', alts.hosting);
  for (const i of [0, 1]) {
    const y = 24 + i * 316,
      id = 'compact-data-' + i;
    s +=
      B(id, 32, y, 576, 284, true) +
      T(
        56,
        y + 50,
        34,
        i ? 'Self-hosted' : 'Cloud-hosted',
        'label',
        'start',
        id,
      ) +
      B(id + '-bot', 56, y + 84, 208, 168, false, id) +
      mark(136, y + 106, 48) +
      T(160, y + 220, 32, 'Bot', 'label', 'middle', id + '-bot') +
      B(id + '-dir', 360, y + 84, 224, 168, false, id) +
      folder(440, y + 112) +
      T(472, y + 220, 32, 'Data', 'label', 'middle', id + '-dir') +
      L('M264 ' + (y + 168) + 'H360', 'relation');
  }
  add('data-compact', 640, 648, s, 'hosting');
  const plain = (s) => s.replace(/<rect data-background-grid[^>]*[/]>/, '');
  for (const l of [...layouts])
    layouts.push({ ...l, name: l.name + '-no-grid', svg: plain(l.svg) });
  const files = [];
  for (const l of layouts) {
    await fs.writeFile(kit + '/' + l.name + '.svg', l.svg);
    await page.setViewportSize({ width: l.w, height: l.h });
    await page.setContent(
      '<style>html,body{margin:0;background:' +
        C.canvas +
        '}svg{display:block}</style>' +
        l.svg,
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
      return {
        fontLoaded: document.fonts.check('500 30px Geist'),
        fonts: [...document.fonts].map((f) => ({
          family: f.family,
          status: f.status,
        })),
        texts: [...document.querySelectorAll('text')].map((e) => ({
          text: e.textContent,
          rect: rect(e),
          size: +e.getAttribute('font-size'),
          box: e.dataset.box
            ? rect(document.getElementById(e.dataset.box))
            : null,
        })),
        contained: [...document.querySelectorAll('[data-parent]')].map((e) => ({
          id: e.id,
          rect: rect(e),
          parent: rect(document.getElementById(e.dataset.parent)),
        })),
        routes: [...document.querySelectorAll('.route,.relation')].map((e) => ({
          kind: e.classList.value,
          d: e.getAttribute('d'),
        })),
      };
    });
    if (
      errors.length ||
      !qa.fontLoaded ||
      qa.fonts.some((f) => f.status !== 'loaded')
    )
      throw Error('Runtime/font failure');
    for (const t of qa.texts) {
      const r = t.rect;
      if (r.x < 0 || r.right > l.w || r.y < 0 || r.bottom > l.h)
        throw Error(l.name + ' canvas ' + t.text + ' ' + JSON.stringify(r));
      if (
        t.box &&
        (r.x < t.box.x + 12 ||
          r.right > t.box.right - 12 ||
          r.y < t.box.y + 12 ||
          r.bottom > t.box.bottom - 12)
      )
        throw Error(
          l.name +
            ' card padding ' +
            t.text +
            ' ' +
            JSON.stringify({ r, box: t.box }),
        );
    }
    for (const n of qa.contained)
      if (
        n.rect.x < n.parent.x + 12 ||
        n.rect.right > n.parent.right - 12 ||
        n.rect.y < n.parent.y + 12 ||
        n.rect.bottom > n.parent.bottom - 12
      )
        throw Error('Containment ' + n.id);
    const png = l.name + '@2x.png';
    await page.screenshot({ path: kit + '/' + png });
    const b = await fs.readFile(kit + '/' + png),
      meta = await sharp(b).metadata();
    if (
      meta.width !== 2 * l.w ||
      meta.height !== 2 * l.h ||
      !(await sharp(b).stats()).isOpaque
    )
      throw Error('PNG metadata');
    const preview = l.name + '-preview.png';
    await page.setViewportSize({
      width: l.embed,
      height: Math.ceil((l.h * l.embed) / l.w),
    });
    await page.addStyleTag({
      content: 'svg{width:' + l.embed + 'px;height:auto}',
    });
    await page.screenshot({ path: kit + '/' + preview });
    files.push({
      name: l.name,
      subject: l.subject,
      svg: l.name + '.svg',
      png,
      preview,
      viewBox: [l.w, l.h],
      pixels: [meta.width, meta.height],
      embedWidth: l.embed,
      sha256: crypto.createHash('sha256').update(b).digest('hex'),
      bytes: b.length,
      qa,
    });
  }
  const source = JSON.parse(
    await fs.readFile(kit + '/source-docs/source-index.json', 'utf8'),
  );
  await fs.writeFile(
    kit + '/tokens.json',
    JSON.stringify(
      {
        source: 'sources/stagewise-ui/package/src/styles/palette.css',
        verifiedBeforeRender: true,
        colors,
        contrastQA,
        grid: {
          opacity: 0.35,
          stepWide: 32,
          stepCompact: 40,
          meaning: 'decorative, continuous behind unboxed text',
        },
        lines: {
          blue: 'MCP connection',
          neutral:
            'Environment exposed by an MCP server; no data-flow direction',
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
        source,
        reference:
          'Approved V4 Overview visual language; compositions adapted independently',
        alts,
        files,
        contrastQA,
        visualReview: { status: 'pending direct actual-export inspection' },
        themeReview: { status: 'pending local docs-theme check' },
        approval:
          'Knuth handles integration and validation; individual Glenn approvals no longer required per Nov10 brief',
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
