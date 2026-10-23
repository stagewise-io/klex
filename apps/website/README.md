# Klex marketing website

Static Vite marketing website. Run `pnpm --filter @klex/website dev` from the repository root.

The homepage at `/` loads `src/new/main.ts` from the root `index.html`. See [the page structure](src/new/README.md) for its sections.

## Brand and press pages

`/brand` and `/press` are separate static HTML entry points, also available with trailing slashes. Both load `src/new/resources/main.ts`, reuse the live navigation and footer, and have route-specific page titles, descriptions, and canonical URLs. Both include a static `robots` meta tag with `noindex`; crawlers can still access the pages and follow their links. Vite emits `brand/index.html` and `press/index.html`; production hosting must support directory-index resolution for those routes.

The brand page follows naming → short description → SVG logo sets → color values. Fixed light and dark preview backgrounds remain visible in either site theme. The square SVGs in `public/brand/` are copies of the existing brand assets; the unframed SVG uses the full existing mascot silhouette with padding and transparent eyes. Logo + wordmark downloads use the existing public SVGs. Palette values come from `src/styles/palette.css` in the `@stagewise/ui` npm package; RGB and HEX are rounded sRGB conversions of the default OKLCH tokens.

The press page links to the brand kit and explains the product and stagewise team. Company background, founder names and roles, locations, and backing were sourced from [the stagewise company site](https://company.stagewise.io/company) and [its homepage](https://company.stagewise.io). No press contact or coverage has been invented.

Validate the resource markup with `pnpm exec vitest run apps/website/src/new/resources/resources.test.ts` and the website build. Neither resource page initializes analytics.

## Logo context menu

The header and footer Klex logos on `/`, `/brand`, and `/press` open the shared UI context menu on right-click or long press. It offers the square logo SVG, logo + wordmark SVG, and a link to `/brand`. Downloads match the site theme when the menu opens. Normal clicks still navigate home. The menu uses the shared accessible context-menu component and cleans up its React roots on hot reload.

## Development demos

`bot-card-demo.html` still uses the prototype card, roster, mascot, and shared styles. Those modules remain separate from the homepage. The previous `/old/` homepage and its exclusive source files have been removed.

## Asset attribution

Asset sources are listed in `public/attributions.html`. Full license texts and copyright notices are collected in `public/third-party-notices.txt`; Vite copies both files into the website build. Font and icon licenses remain alongside their source files.

Validate with `pnpm --filter @klex/website build`, `pnpm --filter @klex/website typecheck`, `pnpm exec vitest run apps/website`, `pnpm format`, and `pnpm format:check`.
