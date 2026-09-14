import { defineConfig } from 'blume';

export default defineConfig({
  title: 'Klex Docs',
  description: 'Documentation powered by Blume.',
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
      display: {
        name: 'Fraunces',
        provider: 'google',
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
});
