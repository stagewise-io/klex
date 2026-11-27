# Klex marketing website

Static Vite marketing website. Run `pnpm --filter @klex/website dev` from the repository root.

The homepage at `/` loads `src/new/main.ts` from the root `index.html`. See [the page structure](src/new/README.md) for its sections.

## Versioned legal pages

`/legal` links to all policies. Default policy pages select and render the effective revision at build time, with no runtime policy fetches. Dated pages, source files and `/legal/policies.json` are also generated during the build. Add dated Markdown under `content/legal/<policy>/`; CI protects existing revisions using Git history. Future effective-date changes require a rebuild and deployment.

## Brand and press pages

`/brand` and `/press` are separate static HTML entry points, also available with trailing slashes. Both load `src/new/resources/main.ts`, reuse the live navigation and footer, and have route-specific page titles, descriptions, and canonical URLs. Both include a static `robots` meta tag with `noindex`; crawlers can still access the pages and follow their links. Vite emits `brand/index.html` and `press/index.html`; production hosting must support directory-index resolution for those routes.

The brand page follows naming → short description → SVG logo sets → color values. Fixed light and dark preview backgrounds remain visible in either site theme. The square SVGs in `public/brand/` are copies of the existing brand assets; the unframed SVG uses the full existing mascot silhouette with padding and transparent eyes. Logo + wordmark downloads use the existing public SVGs. Palette values come from `src/styles/palette.css` in the `@stagewise/ui` npm package; RGB and HEX are rounded sRGB conversions of the default OKLCH tokens.

The press page links to the brand kit and explains the product and stagewise team. Company background, founder names and roles, locations, and backing were sourced from [the stagewise company site](https://company.stagewise.io/company) and [its homepage](https://company.stagewise.io). No press contact or coverage has been invented.

Validate the resource markup with `pnpm exec vitest run apps/website/src/new/resources/resources.test.ts` and the website build. Both resource pages initialize the same analytics module as the homepage.

## Logo context menu

The header and footer Klex logos on `/`, `/brand`, and `/press` open the shared UI context menu on right-click or long press. It offers the square logo SVG, logo + wordmark SVG, and a link to `/brand`. Downloads match the site theme when the menu opens. Normal clicks still navigate home. The menu uses the shared accessible context-menu component and cleans up its React roots on hot reload.

## Optional website analytics

The homepage uses the same PostHog configuration as the previous website:
`VITE_POSTHOG_KEY` (the public `phc_` project token) and `VITE_POSTHOG_HOST`
(`https://eu.i.posthog.com`, optionally with a trailing slash). Keep the existing
production build variables to continue sending to the same project. Vite embeds
these public values at build time; rebuild after changing them. Never use a
personal API key or secret in a `VITE_` variable. For local testing, copy
`.env.example` to `.env.local` and supply the public project token. Missing or
invalid configuration disables capture.

When configured, the homepage, brand page, and press page lazy-load the pinned
PostHog browser SDK. Standard pageviews (including History API navigation),
page-leave events, and autocapture are enabled. There is no custom `before_send`
sanitizer or event/property allowlist: full URLs (including query strings and
fragments), actual host and pathname, referrers, campaign parameters, browser/device
metadata, session IDs, and normal element data remain available to PostHog.
The SDK's built-in sensitive-field exclusions and bot filtering still apply.

PostHog manages visitor identity using its standard localStorage and cookie
persistence, so visitors and sessions can be recognized across page loads.
There is no per-document ID override. Person profiles use `identified_only`;
this website does not call `identify` or attach Cloud account identity.
Session replay remains explicitly disabled. Other analytics features use SDK and
project defaults instead of being globally blocked by this module.

Do Not Track (`1` or `yes`) and Global Privacy Control prevent SDK initialization.
SDK failures do not block the website. Generated legal pages and development demos
do not load this entry point. Blockers, privacy signals, and network failures
still make counts incomplete.

Persistent analytics storage and expanded collection require an accurate public
disclosure and review of applicable device-access/consent requirements before
production rollout. This module does not provide consent UI. The existing privacy
policy describes the previous memory-only implementation; update it through the
versioned legal publishing process before enabling this configuration.

Verify with `pnpm exec vitest run apps/website/src/new/telemetry`, the website
build/typecheck, and the repository formatter. Tests use a synthetic project token
and a mocked SDK, not live credentials. After deployment, verify `$pageview` and
`$autocapture` in PostHog's live events view, inspect the actual event properties,
and confirm that no recordings appear.

## Development demos

`bot-card-demo.html` still uses the prototype card, roster, mascot, and shared styles. Those modules remain separate from the homepage. The previous `/old/` homepage and its exclusive source files have been removed.

## Asset attribution

Asset sources are listed in `public/attributions.html`. Full license texts and copyright notices are collected in `public/third-party-notices.txt`; Vite copies both files into the website build. Font and icon licenses remain alongside their source files.

Validate with `pnpm --filter @klex/website build`, `pnpm --filter @klex/website typecheck`, `pnpm exec vitest run apps/website`, `pnpm format`, and `pnpm format:check`.
