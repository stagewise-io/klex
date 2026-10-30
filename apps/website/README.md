# Klex marketing website

Static Vite marketing website. Run `pnpm --filter @klex/website dev` from the repository root.

The homepage at `/` loads `src/new/main.ts` from the root `index.html`. See [the page structure](src/new/README.md) for its sections.

## Versioned legal pages

`/legal/privacy` and `/legal/terms` select the latest effective Markdown revision in the browser. Dated revision pages and original source downloads are static; `/legal/policies.json` lists every revision newest-first with UTC effective dates, fixed URLs, and exact-byte SHA-256 hashes. Add dated Markdown under `content/legal/<policy>/`; hashes are computed during the build and CI protects existing revisions using Git history. No approved text is included yet. See [legal authoring, nginx configuration, cloud integration, and launch checks](LEGAL.md).

## Brand and press pages

`/brand` and `/press` are separate static HTML entry points, also available with trailing slashes. Both load `src/new/resources/main.ts`, reuse the live navigation and footer, and have route-specific page titles, descriptions, and canonical URLs. Both include a static `robots` meta tag with `noindex`; crawlers can still access the pages and follow their links. Vite emits `brand/index.html` and `press/index.html`; production hosting must support directory-index resolution for those routes.

The brand page follows naming → short description → SVG logo sets → color values. Fixed light and dark preview backgrounds remain visible in either site theme. The square SVGs in `public/brand/` are copies of the existing brand assets; the unframed SVG uses the full existing mascot silhouette with padding and transparent eyes. Logo + wordmark downloads use the existing public SVGs. Palette values come from `src/styles/palette.css` in the `@stagewise/ui` npm package; RGB and HEX are rounded sRGB conversions of the default OKLCH tokens.

The press page links to the brand kit and explains the product and stagewise team. Company background, founder names and roles, locations, and backing were sourced from [the stagewise company site](https://company.stagewise.io/company) and [its homepage](https://company.stagewise.io). No press contact or coverage has been invented.

Validate the resource markup with `pnpm exec vitest run apps/website/src/new/resources/resources.test.ts` and the website build. Neither resource page initializes analytics.

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

When configured, the homepage lazy-loads the pinned PostHog browser SDK and
captures one `$pageview` per document plus `$autocapture` click events on links,
buttons, button-role controls, and disclosure summaries, without consent UI.
Do Not Track (`1` or `yes`) and Global Privacy Control prevent SDK initialization.
Inputs, selects, textareas, editable content, and PostHog opt-out elements are
excluded. Form changes, submissions, and clipboard events are not captured.

Persistence is disabled and configured as memory-only. Each document gets a fresh
random ID shared by its pageview and clicks; unique IDs count page loads, not
unique people. No cookies or persistent visitor identity are used, and person
profiles are disabled. All text and element attributes are masked. A fail-closed
`before_send` hook allows only pageviews and click autocapture: outgoing properties
contain the project token, document-local ID, fixed `/` page label, and privacy
flags, plus element tag names and sibling positions for clicks. Browser URLs,
query strings, referrers, titles, text, classes, IDs, link destinations, device
properties, session/window IDs, and person updates are stripped. This means click
actions must use structural selectors rather than button text or link URLs;
selectors may need updating when the markup changes.

Session recording, active-visitor heartbeats, page-leave events, rage/dead clicks,
heatmaps, performance/error capture, surveys, product tours, conversations,
experiments, remote feature flags, and external script loading are disabled or
excluded from outgoing events. There is no reliable active/returning visitor or
cross-page session metric. The SDK uses its standard best-effort transport,
batching, and retry behavior; the previous direct-fetch transport guarantees no
longer apply. Brand, press, and demo pages remain untracked.

Before enabling production analytics, enable PostHog's **Discard client IP data**
project setting and disable IP-based enrichment. The payload includes `$ip: null`,
`$geoip_disable: true`, and `$process_person_profile: false`, but the receiving
infrastructure still sees network metadata such as the source IP and User-Agent.
Autocapture broadens collection beyond traffic-volume measurement. Review the
existing analytics disclosure and consent requirements before production rollout;
cookie-free does not guarantee that policy changes or consent are unnecessary.
Blockers, privacy signals, and network failures make counts incomplete.

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
