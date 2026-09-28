# Klex marketing website

## Optional website analytics

Copy `.env.example` to `.env.local` in this directory and set `VITE_POSTHOG_KEY`
to the **public project token**, and `VITE_POSTHOG_HOST` to your project's HTTPS
ingestion origin (for example `https://eu.i.posthog.com`). Never put a personal
API key or secret in a `VITE_` variable: Vite embeds these values in the public
bundle at build time. Rebuild after changing them. Missing/blank keys, missing
hosts, and invalid hosts disable telemetry and hide the consent controls.

Before enabling production analytics, enable **Settings → Project → IP data
capture configuration → Discard client IP data** in PostHog and disable IP-based
GeoIP/bot enrichment transformations. The client sends `$ip: null` and
`$geoip_disable: true`; the project setting is required to ensure PostHog does
not retain the network source IP. The deprecated SDK `ip: false` option is not
a reliable control. The receiving service necessarily sees a network IP while
handling the request; this implementation does not promise network-level
anonymity. See [PostHog's data storage controls](https://posthog.com/docs/privacy/data-storage).

The accessible footer controls offer equally styled Allow analytics / No thanks
buttons. Nothing is sent before explicit opt-in. Do Not Track (`1` or `yes`) and
Global Privacy Control disable analytics, including a second check when consent
is given. Choices apply only to the current document; no cookies, local storage,
session storage, or persistent identity/preferences are written. Turning off
analytics aborts an in-flight request but cannot recall an already received event.

Only one `$pageview` per consenting document is sent directly to PostHog's
capture API, with a fresh random ID, a fixed `/` page label, and
`$process_person_profile: false` / `$is_identified: false`. No SDK is loaded, so
there is no autocapture, session recording, DOM/input capture, click tracking,
remote configuration, or person identification. No URL queries, fragments,
arbitrary paths, referrers, page titles, or user properties are copied into events.
Requests omit credentials and the Referer header; failures are ignored without
retrying. This static landing page has no client-side routes to track; anchor
navigation and demo interactions do not generate page views.

In PostHog Product Analytics, count `$pageview` events for consenting page loads.
“Unique visitors” counts random document IDs, **not unique people**: reloads and
repeat visits count separately, while nonconsenting visitors, privacy signals,
blocked requests, and network failures are absent. This measures opted-in traffic
volume, not the site's full audience, retention, or sessions. Standard Web
Analytics reports requiring session IDs, referrers, or device metadata may be
incomplete. There is no IP-derived cookieless fingerprint/server hash.

Verify with `pnpm exec vitest run apps/website/src/telemetry.test.ts` plus the
website build/typecheck and repository formatter. For a manual network check,
build with a test project token: there should be no PostHog requests before
consent or after declining, exactly one capture after allowing, and none with
Do Not Track enabled. Inspect the payload and verify the project's IP discard
setting before enabling production. No live project credentials are needed by
the automated tests.

Static Vite marketing demo. Run `pnpm --filter @klex/website dev` from the repository root.

The connector workflow increment replaces the earlier Harry/Sarah panel examples described below. `connector-registry.ts` defines connector metadata; `connector-scenarios.ts` keys illustrative scenarios by `botId:connectorId`, with connector-specific fallbacks. `connector-shells.tsx` provides reusable Slack, GitHub, Google Workspace/Calendar, and Linear frames with shared messages, participant avatars, status, and content blocks. Kristine’s middle connector is Linear; the other bots retain GitHub. The original necklace order and three-connector spacing remain intact.

`KlexBotRoster` owns committed selection and transient preview. Its optional render child receives the current preview or committed pair. Hover/focus previews; click/Enter/Space commits; leaving a preview restores the committed connector. Changing bots resets to the first connector synchronously. Background frames use the current bot and are inert and hidden from accessibility APIs; mobile shows only the selected frame. No backend or integration calls are made. Scenario coverage is checked in `connector-scenarios.test.tsx`.

The landing page extends `DESIGN.md` and `PRODUCT.md`: warm shared UI tokens, locally served Fraunces headings, bundled Geist Variable UI text, and a restrained blue action color. The hero contains illustrative Slack, Gmail, Google Calendar, and GitHub examples. Harry and Sarah are named digital coworkers with their own identities. These examples do not assert that those connectors ship with Klex.

The React panel section shows Harry and Sarah with layered native interfaces and Gmail frontmost. Pointer movement or keyboard focus brings a connector panel forward. A shared `KlexBotRoster` places Jonathan, Kristine, Monica, and Jeff in an orbit to the left of the panels. Jonathan starts active; exactly one bot stays active. Clicking or pressing Enter/Space on another bot transfers activation, while hovering or focusing a bot only plays its distinct mascot gesture. Active cards expand into a centered name, mascot, circular integration necklace, and identity; inactive cards remain compact with inert integrations and no details. Active integrations preview on hover/focus and lock on click. The `/bot-card-demo.html` development route uses the same roster and selection behavior. The orbit stacks above the panels below 1200px; cards stack in stable order at 680px and below. Motion honors reduced-motion preferences. This is local UI state and makes no external connection. At narrow widths, interfaces stack and secondary sidebars collapse. Native app previews retain their light appearance in dark mode.

The page follows the prototype order: hero/demo, positioning, three capability columns, company stories, three Guides bullets, and five FAQ questions. Company tabs share the prototype’s single media/story panel and Kristine/Jonathan/Nat copy. The repeated X/Y FAQ questions are prototype placeholders. CompanyA has no supplied URL, so its link is disabled pending a destination. There is no installer or separate coworker-story section.

Company images are mapped in `src/sections.ts` to the matching user-supplied PNGs in `public/company-stories/`: `marcel.png`, `tobi.png`, and `jeff.png`. The original 1672 × 941 images are copied without transformation. The shared panel retains its responsive, uncropped sizing with `object-fit: contain`, descriptive alt text, intrinsic dimensions, lazy loading, and asynchronous decoding.

No backend or external font service is required. Asset provenance is listed in `public/attributions.html`; existing fonts, mascots, and connector logos are preserved.

Validation: `pnpm --filter @klex/website build`, `pnpm --filter @klex/website typecheck`, `pnpm exec biome check apps/website`, `pnpm format`, `pnpm format:check`, and `git diff --check`. Structure and copy were compared with the cached Figma node export for frame `1:134`; pixel fidelity has not been verified.
