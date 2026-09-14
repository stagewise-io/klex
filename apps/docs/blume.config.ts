import { defineConfig } from 'blume';

export default defineConfig({
  title: 'Klex Docs',
  description: 'Documentation for Klex — one durable agent, many channels.',
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
  // Server output + Vercel adapter are required for the MCP server endpoint.
  // deployment.site is the canonical URL — needed for sitemaps, OG images,
  // RSS feeds, JSON-LD, and all agent-discovery manifests to emit absolute URLs.
  deployment: {
    output: 'server',
    adapter: 'vercel',
    site: 'https://docs.klex.bot',
  },
  navigation: {
    featured: [
      {
        label: 'Klex Homepage',
        href: 'https://klex.bot',
        icon: 'home',
      },
    ],
  },
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
      name: 'stagewise',
      url: 'https://stagewise.io',
      sameAs: ['https://github.com/stagewise-io', 'https://stagewise.io'],
    },
  },
  // AI-facing features: llms.txt manifest, MCP server, and the
  // "Open in chat" page action (subset — v0, Scira, and Cursor removed).
  ai: {
    llmsTxt: true,
    mcp: {
      enabled: true,
      route: '/mcp',
    },
    openInChat: ['chatgpt', 'claude', 't3'],
  },
});
