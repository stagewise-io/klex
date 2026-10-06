import './resources.css';

import { pngWidths } from './png-downloads';

const downloadIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>`;

const shortDescription =
  'Klex is an open-source platform for autonomous digital coworkers. Klex Bots have their own identities, lasting memory, and connected work environments, and collaborate through the tools teams already use. Run them locally or use Klex Cloud for integrations, hosted agents, and computers.';

function assetPreview(
  title: string,
  description: string,
  source: string,
  theme: 'light' | 'dark',
  kind: 'lockup' | 'symbol',
) {
  return `<figure class="resource-asset">
    <div class="resource-preview resource-preview-${theme}"><img class="resource-${kind}" src="${source}" alt="${title}" width="${kind === 'lockup' ? 332 : 100}" height="${kind === 'lockup' ? 123 : 100}" loading="lazy" /></div>
    <figcaption>
      <div class="resource-asset-title"><div><h3>${title}</h3><p>${description}</p></div><a class="resource-download" href="${source}" download aria-label="Download ${title} as SVG">${downloadIcon}<span>SVG</span></a></div>
      <div class="resource-png-controls">
        <select class="resource-resolution" aria-label="PNG resolution for ${title}">${pngWidths.map((width) => `<option value="${width}" ${width === 1024 ? 'selected' : ''}>${kind === 'lockup' ? `${width} px wide` : `${width} × ${width} px`}</option>`).join('')}</select>
        <button class="resource-download" type="button" data-png-source="${source}" aria-label="Download ${title} as PNG">${downloadIcon}<span>PNG</span></button>
        <p class="resource-download-status" role="status" aria-live="polite"></p>
      </div>
    </figcaption>
  </figure>`;
}

export const brandMarkup = `
  <div class="resource-heading">
    <h1>The Klex brand</h1>
    <p>Our name, our marks, and our colors. Everything you need to represent Klex clearly and consistently.</p>
    <nav class="resource-index" aria-label="On this page"><a href="#name">Name</a><a href="#description">Description</a><a href="#logos">Logos</a><a href="#colors">Colors</a></nav>
  </div>
  <section class="resource-section" id="name" aria-labelledby="name-title">
    <h2 id="name-title">Naming</h2>
    <div class="resource-section-body">
      <p class="resource-lead">Always <strong>Klex</strong>. A capital K, followed by lowercase lex.</p>
      <dl class="resource-definitions">
        <div><dt>Klex</dt><dd>The brand behind the full digital coworker experience.</dd></div>
        <div><dt>Klex Bots</dt><dd>The individual digital coworkers. Write Klex Bot in the singular and Klex Bots in the plural, with a space and a capital B. Use lowercase bots when referring to them generically.</dd></div>
        <div><dt>Klex Cloud</dt><dd>Our cloud offering for integrations, hosted agents, and computers. Always two words, with a capital C.</dd></div>
      </dl>
    </div>
  </section>
  <section class="resource-section" id="description" aria-labelledby="description-title">
    <h2 id="description-title">Short description</h2>
    <div class="resource-section-body"><p class="resource-lead">${shortDescription}</p><p>For articles, listings, and introductions. For more product and company background, visit our <a href="/press">press page</a>.</p></div>
  </section>
  <section class="resource-section resource-section-wide" id="logos" aria-labelledby="logos-title">
    <div class="resource-section-intro"><h2 id="logos-title">Logo sets</h2><p>Use the logo and wordmark together where space allows. The rounded square mark works for app icons; the square-corner avatar fills its box edge to edge, so the platform can apply its own crop. The unframed mark keeps the entire silhouette visible on badges and custom backgrounds. Download the original SVG or choose a resolution for a PNG generated in your browser. PNGs preserve the artwork’s aspect ratio and any transparent areas.</p></div>
    <div class="resource-assets">
      ${assetPreview('Logo + wordmark · light', 'For light backgrounds', '/klex-logo-light.svg', 'light', 'lockup')}
      ${assetPreview('Logo + wordmark · dark', 'For dark backgrounds', '/klex-logo-dark.svg', 'dark', 'lockup')}
      ${assetPreview('Square logo · light', 'For avatars and app icons', '/brand/klex-square-light.svg', 'light', 'symbol')}
      ${assetPreview('Square logo · dark', 'For avatars and app icons', '/brand/klex-square-dark.svg', 'dark', 'symbol')}
      ${assetPreview('Avatar logo', 'Boxed mascot with square corners for profile images', '/brand/klex-avatar.svg', 'light', 'symbol')}
      ${assetPreview('Unframed logo', 'Full silhouette for badges and custom backgrounds', '/brand/klex-unframed.svg', 'light', 'symbol')}
    </div>
    <p class="resource-note">Keep the proportions and colors intact. Give the mark room to breathe, use a contrasting background, and don’t crop, stretch, or add effects.</p>
  </section>
  <section class="resource-section resource-section-wide" id="colors" aria-labelledby="colors-title">
    <div class="resource-section-intro"><h2 id="colors-title">Our colors</h2><p>Our core palette. OKLCH is the source value; RGB and HEX are rounded sRGB equivalents for other tools.</p></div>
    <div class="resource-colors">
      <article class="resource-color"><div class="resource-swatch resource-swatch-paper" role="img" aria-label="Light Base (base-50) color preview"></div><h3>Light Base</h3><p>base-50</p><dl><div><dt>OKLCH</dt><dd>0.992 0.001 85</dd></div><div><dt>RGB</dt><dd>253, 252, 252</dd></div><div><dt>HEX</dt><dd>#FDFCFC</dd></div></dl></article>
      <article class="resource-color"><div class="resource-swatch resource-swatch-ink" role="img" aria-label="Dark Base (base-900) color preview"></div><h3>Dark Base</h3><p>base-900</p><dl><div><dt>OKLCH</dt><dd>0.198 0.0005 85</dd></div><div><dt>RGB</dt><dd>22, 21, 21</dd></div><div><dt>HEX</dt><dd>#161515</dd></div></dl></article>
      <article class="resource-color"><div class="resource-swatch resource-swatch-primary" role="img" aria-label="Klex Blue (primary-500) color preview"></div><h3>Klex Blue</h3><p>primary-500</p><dl><div><dt>OKLCH</dt><dd>0.5455 0.25 265</dd></div><div><dt>RGB</dt><dd>37, 89, 254</dd></div><div><dt>HEX</dt><dd>#2559FE</dd></div></dl></article>
    </div>
  </section>
`;

export const pressMarkup = `
  <div class="resource-heading">
    <h1>Press Kit</h1>
    <p>Product context and the people behind it. A starting point for anyone writing about Klex.</p>
    <a class="resource-text-link" href="/brand">Explore the brand kit <span aria-hidden="true">→</span></a>
  </div>
  <section class="resource-section" aria-labelledby="press-product-title">
    <h2 id="press-product-title">About our Bots</h2>
    <div class="resource-section-body">
      <p class="resource-lead">Klex is an open-source platform for autonomous digital coworkers, built by stagewise. We build bots, not agents. Klex Bots are designed to participate in a team’s work rather than sit alongside it as a separate chat tool.</p>
      <p>We see bots as the next evolution of agents: less constrained by individual tasks or chat sessions, and able to act autonomously and proactively. Rather than waiting for every instruction, a Klex Bot can recognize what needs attention, take initiative, and keep work moving across connected environments, within the permissions its team sets.</p>
      <p>Each Klex Bot maintains a durable identity and memory across conversations and work environments. Teams communicate with their bots through connected channels and give them access to tools and machines through the Model Context Protocol (MCP). The aim is one coherent coworker, without asking users to manage model sessions or the orchestration behind them.</p>
      <p>Klex separates a bot’s durable state from the environments where work happens. Its brain, memory, and configuration remain with the bot; external tools and computers are connected environments. This lets the coworker retain its context as its work moves between systems. It also makes hosting Klex Bots significantly safer and less compute-intense.</p>
      <p>Klex supports multiple model providers and can run locally or be self-hosted. Klex Cloud is the hosted offering, bringing together integrations, hosted bots, and computers. The brand is Klex; the individual coworkers are Klex Bots; the cloud offering is Klex Cloud.</p>
      <div class="resource-inline-links"><a href="https://docs.klex.bot">Product documentation</a><a href="https://github.com/stagewise-io/klex">Open-source repository</a></div>
    </div>
  </section>
  <section class="resource-section" aria-labelledby="press-team-title">
    <h2 id="press-team-title">Built by stagewise</h2>
    <div class="resource-section-body">
      <p class="resource-lead">stagewise builds applied AI with a simple premise: bots should be partners that tackle work autonomously, not tools people talk to on the side.</p>
      <p>The team started in software development, working on a gap between increasingly capable models and the limited context they could access. Its early work connected agents to the live state of an application: the running interface, selected elements, and surrounding code.</p>
      <p>That experience shaped the team’s approach to bots. Capability depends not only on a model, but also on context, lasting memory, access to surrounding systems, and clear permissions. Klex brings this thinking to digital coworkers that can work across the environments a team already uses.</p>
      <figure class="resource-founder-photo">
        <img src="/press/stagewise-klex-founders.jpeg" alt="The two stagewise co-founders, Glenn Töws and Julian Götze" width="3754" height="2816" loading="lazy" decoding="async" />
        <figcaption><span>stagewise co-founders · 3754 × 2816 px</span><a class="resource-download" href="/press/stagewise-klex-founders.jpeg" download="stagewise-klex-founders.jpeg" aria-label="Download the stagewise founders photo at full resolution">${downloadIcon}<span>Download full resolution</span></a></figcaption>
      </figure>
      <dl class="resource-founders"><div><dt>Glenn Töws</dt><dd>Co-founder &amp; Chief Executive Officer</dd></div><div><dt>Julian Götze</dt><dd>Co-founder &amp; Chief Technology Officer</dd></div></dl>
      <p>stagewise is based in Bielefeld, Germany, and San Francisco, USA. The company is backed by Y Combinator, TwentyTwo Ventures, BLAST VC, and angel investors.</p>
      <p>Its stated principles are openness, configurability, affordability, and simplicity: let people choose their models and systems, define the boundaries of autonomy, and focus on useful outcomes rather than token consumption.</p>
      <a class="resource-text-link" href="https://company.stagewise.io/company">More about the company and team <span aria-hidden="true">→</span></a>
    </div>
  </section>
`;
