import { defineConfig } from 'blume';
import { posthog } from 'blume/analytics';

const posthogKey = process.env.POSTHOG_KEY?.trim();
const posthogHost = process.env.POSTHOG_HOST?.trim();

export default defineConfig({
  title: 'Klex Docs',
  description: 'Documentation for Klex — one durable agent, many channels.',
  analytics:
    posthogKey && posthogHost
      ? [posthog({ key: posthogKey, host: posthogHost })]
      : [],
  theme: {
    // @stagewise/ui primary palette (hue 265, chroma scale 1)
    // light: primary-500 (peak chroma), dark: primary-400
    accent: {
      light: 'oklch(0.5455 0.25 265)',
      dark: 'oklch(0.62 0.23 265)',
    },
    // @stagewise/ui base palette (hue 85, chroma scale 1)
    // light: base-50, dark: base-950
    background: {
      light: 'oklch(0.992 0.001 85)',
      dark: 'oklch(0.161 0.0003 85)',
    },
    fonts: {
      body: 'geist',
      // Display serif (Fraunces) is self-hosted from public/fonts/. Passing
      // it as a LocalFontConfig (not a Google slug) lets Blume auto-derive the
      // OG card's font-family mapping: display → headline, body → subtitle and
      // footer. The @font-face in theme.css still wins for the browser (loaded
      // last, font-display: block) — this config is what feeds Satori.
      display: {
        name: 'Fraunces',
        variants: [
          {
            src: 'public/fonts/fraunces-500.woff2',
            weight: 500,
            style: 'normal',
          },
        ],
        fallback: 'serif',
      },
    },
  },
  logo: {
    image: {
      light: '/wordmark-light.svg',
      dark: '/wordmark-dark.svg',
      alt: 'Klex',
    },
    text: '',
  },
  // Canonical site URL — needed for sitemaps, OG images, RSS feeds, JSON-LD,
  // and all agent-discovery manifests to emit absolute URLs.
  // Static output (the default) — no server adapter needed.
  deployment: {
    site: 'https://docs.klex.bot',
  },
  navigation: {
    tabs: [
      { label: 'Understand Klex Bots', path: '/bot' },
      { label: 'Use the Klex Cloud', path: '/cloud' },
      { label: 'Bot-Native Company Guide', path: '/guides' },
    ],
    featured: [
      {
        label: 'Klex Homepage',
        href: 'https://www.klex.bot',
        icon: 'home',
      },
    ],
  },
  // Keep published URLs working: pre-tab URLs in every locale, plus English
  // pages that moved again when the Bot tab was re-sectioned into concepts/
  // guides/reliability/faq. Locale placeholders use the current fallback paths.
  redirects: [
    // English: pre-tab URLs → current (re-sectioned) paths.
    { from: '/', to: '/bot' },
    { from: '/quickstart', to: '/bot/quickstart' },
    // Use cases are being reworked; keep the old route usable in the meantime.
    { from: '/bot/use-cases', to: '/bot', status: 302 },
    { from: '/architecture', to: '/bot/concepts/how-bots-work' },
    { from: '/concepts/cognitive-architecture', to: '/bot/concepts/memory' },
    { from: '/concepts/soul', to: '/bot/concepts/soul' },
    { from: '/concepts/god-messages', to: '/bot/concepts/god-messages' },
    { from: '/concepts/model-providers', to: '/bot/concepts/models' },
    { from: '/concepts/model-selection', to: '/bot/concepts/models' },
    { from: '/concepts/data-directory', to: '/bot/concepts/data-directory' },
    // English: first-sectioned URLs → re-sectioned paths.
    { from: '/bot/architecture', to: '/bot/concepts/how-bots-work' },
    {
      from: '/bot/concepts/cognitive-architecture',
      to: '/bot/concepts/memory',
    },
    { from: '/bot/concepts/model-providers', to: '/bot/concepts/models' },
    { from: '/bot/concepts/model-selection', to: '/bot/concepts/models' },
    // Locale URLs: map renamed placeholders to their current fallback pages.
    ...[
      '/zh',
      '/ja',
      '/ko',
      '/de',
      '/fr',
      '/es',
      '/pt',
      '/hi',
      '/uk',
      '/ru',
      '/ar',
    ].flatMap((locale) => {
      const renamed = [
        ['/architecture', '/concepts/how-bots-work'],
        ['/concepts/model-providers', '/concepts/models'],
        ['/concepts/model-selection', '/concepts/models'],
      ];
      const unchanged = [
        '',
        '/quickstart',
        '/concepts/cognitive-architecture',
        '/concepts/soul',
        '/concepts/god-messages',
        '/concepts/data-directory',
      ];
      return [
        {
          from: `${locale}/bot/use-cases`,
          to: `${locale}/bot`,
          status: 302 as const,
        },
        ...unchanged.map((path) => ({
          from: `${locale}${path}`,
          to: `${locale}/bot${path}`,
        })),
        ...renamed.flatMap(([oldPath, newPath]) => [
          { from: `${locale}${oldPath}`, to: `${locale}/bot${newPath}` },
          { from: `${locale}/bot${oldPath}`, to: `${locale}/bot${newPath}` },
        ]),
      ];
    }),
  ],
  // Discoverability: SEO + AEO. Most features are on by default, but
  // deployment.site must be set (done above) for absolute URLs to work.
  // Structured data (JSON-LD) feeds both search engines and AI answer engines.
  seo: {
    og: {
      enabled: true,
      logo: '/og-logo.svg',
      // og.fonts is intentionally omitted — when theme.fonts is explicitly
      // configured (above), Blume auto-derives both the font files and the
      // family mapping (display → headline, body → subtitle/footer) for
      // Satori. Passing og.fonts manually would load files but leave the
      // family mapping undefined, causing everything to render in one font.
      palette: {
        accent: '#2559FE',
        background: '#161515',
        foreground: '#FDFDFC',
        muted: '#a6a19f',
        border: '#323232',
      },
    },
    rss: { enabled: true },
    sitemap: true,
    robots: true,
    structuredData: true,
    software: {
      license: 'Apache-2.0',
      operatingSystem: 'Node.js',
      price: 0,
      sameAs: ['https://github.com/stagewise-io/klex'],
    },
    organization: {
      name: 'stagewise GmbH',
      url: 'https://stagewise.io',
      sameAs: ['https://github.com/stagewise-io', 'https://stagewise.io'],
    },
  },
  // i18n: 11 locales. English lives at the content root; other locales are
  // top-level directories under docs/ (dir parser). UI chrome auto-translates
  // via Blume's built-in packs. Arabic uses RTL text direction.
  i18n: {
    defaultLocale: 'en',
    fallbackLocale: 'en',
    hideDefaultLocalePrefix: true,
    parser: 'dir',
    locales: [
      { code: 'en', label: 'English' },
      { code: 'zh', label: '中文' },
      { code: 'ja', label: '日本語' },
      { code: 'ko', label: '한국어' },
      { code: 'de', label: 'Deutsch' },
      { code: 'fr', label: 'Français' },
      { code: 'es', label: 'Español' },
      { code: 'pt', label: 'Português' },
      { code: 'hi', label: 'हिन्दी' },
      { code: 'uk', label: 'Українська' },
      { code: 'ru', label: 'Русский' },
      { code: 'ar', label: 'العربية', dir: 'rtl' },
    ],
  },
  // AI-facing features: llms.txt manifest and the "Open in chat" page action.
  // MCP server is disabled — it requires server output which we don't use.
  agents: {
    llmsTxt: true,
    mcp: {
      enabled: false,
    },
  },
  ai: {
    openInChat: ['chatgpt', 'claude', 't3'],
  },
});
