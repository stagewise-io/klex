# Klex marketing website

Static Vite marketing website. Run `pnpm --filter @klex/website dev` from the repository root.

The homepage at `/` loads `src/new/main.ts` from the root `index.html`. See [the page structure](src/new/README.md) for its sections. The previous homepage remains at `/old/`, where `old/index.html` loads `src/main.ts`.

## Optional website analytics

Copy `.env.example` to `.env.local` in this directory and set `VITE_POSTHOG_KEY`
to the **public project token** (`phc_` followed by letters/digits), and
`VITE_POSTHOG_HOST` explicitly to `https://eu.i.posthog.com` (an optional trailing
slash is accepted). Only this EU ingestion host is allowed. Never put a personal
API key or secret in a `VITE_` variable: Vite embeds these values in the public
bundle at build time. Rebuild after changing them. Missing or invalid configuration
disables telemetry without rendering anything. Token validation checks syntax,
not whether the token belongs to an existing EU project.

Before enabling production analytics, enable **Settings → Project → IP data
capture configuration → Discard client IP data** in PostHog and disable IP-based
GeoIP/bot enrichment transformations. The client sends `$ip: null` and
`$geoip_disable: true`; the project setting is required to ensure PostHog does
not retain the network source IP. The deprecated SDK `ip: false` option is not
a reliable control. The receiving service necessarily sees a network IP while
handling the request; this implementation does not promise network-level
anonymity. See [PostHog's data storage controls](https://posthog.com/docs/privacy/data-storage).

This is **non-consensual minimal measurement** for capacity planning: when
configured, it runs automatically without opt-in or a consent/footer UI. Do Not
Track (`1` or `yes`) and Global Privacy Control suppress the request at
initialization. No cookies, localStorage, sessionStorage, or persistent
identity/preferences are read or written. There is no in-page consent or
withdrawal control. Payload minimization is not a claim of anonymity or that
consent is unnecessary in every deployment.

At most one `$pageview` per document is attempted directly through PostHog's
capture API, with a fresh random ID, a fixed `/` page label, and
`$process_person_profile: false` / `$is_identified: false`. No SDK is loaded, so
there is no autocapture, session recording, DOM/input capture, click tracking,
remote configuration, or person identification. No URL queries, fragments,
arbitrary paths, referrers, page titles, or user properties are copied into events.
Requests omit credentials and the Referer header, and reject redirects; failures
are ignored without retrying. Browser-generated network metadata (including the
source IP, User-Agent, and Origin) can still reach the receiving infrastructure;
the application payload allowlist does not control its logging or processing.
This static landing page has no client-side routes to track; anchor
navigation and demo interactions do not generate page views.

In PostHog Product Analytics, count `$pageview` events for measured page loads.
“Unique visitors” counts random document IDs, **not unique people**: reloads and
repeat visits count separately, while privacy signals, disabled configuration,
blocked requests, and network failures are absent. Bots may contribute events.
This is a rough traffic-volume input for capacity planning, not a complete request
count, unique audience, retention, concurrency, or session measurement. Standard Web
Analytics reports requiring session IDs, referrers, or device metadata may be
incomplete. There is no IP-derived cookieless fingerprint/server hash.

Verify with `pnpm exec vitest run apps/website/src/telemetry.test.ts` plus the
website build/typecheck and repository formatter. For a manual network check,
build with a synthetic `phc_` token and intercept the ingestion endpoint: expect
one automatic capture, none on interactions, a fresh ID after reload, no
analytics UI or storage/cookie access, and no capture with Do Not Track or GPC.
Missing/invalid configuration must send nothing. Inspect the payload and
verify the project's IP discard and disabled enrichment
setting before enabling production. No live project credentials are needed by
the automated tests.

## Earlier prototype components

The connector workflow increment replaces the earlier Harry/Sarah panel examples described below. `connector-registry.ts` defines connector metadata; `connector-scenarios.ts` keys illustrative scenarios by `botId:connectorId`, with connector-specific fallbacks. `connector-shells.tsx` provides reusable Slack, GitHub, Google Workspace/Calendar, and Linear frames with shared messages, participant avatars, status, and content blocks. Kristine’s middle connector is Linear; the other bots retain GitHub. The original necklace order and three-connector spacing remain intact.

`KlexBotRoster` owns committed selection and transient preview. Its optional render child receives the current preview or committed pair. Hover/focus previews; click/Enter/Space commits; leaving a preview restores the committed connector. Changing bots resets to the first connector synchronously. Background frames use the current bot and are inert and hidden from accessibility APIs; mobile shows only the selected frame. No backend or integration calls are made. Scenario coverage is checked in `connector-scenarios.test.tsx`.

The landing page extends `DESIGN.md` and `PRODUCT.md`: warm shared UI tokens, locally served Fraunces headings, bundled Geist Variable UI text, and a restrained blue action color. The hero contains illustrative Slack, Gmail, Google Calendar, and GitHub examples. Harry and Sarah are named digital coworkers with their own identities. These examples do not assert that those connectors ship with Klex.

The React panel section shows Harry and Sarah with layered native interfaces and Gmail frontmost. Pointer movement or keyboard focus brings a connector panel forward. A shared `KlexBotRoster` places Jonathan, Kristine, Monica, and Jeff in an orbit to the left of the panels. Jonathan starts active; exactly one bot stays active. Clicking or pressing Enter/Space on another bot transfers activation, while hovering or focusing a bot only plays its distinct mascot gesture. Active cards expand into a centered name, mascot, circular integration necklace, and identity; inactive cards remain compact with inert integrations and no details. Active integrations preview on hover/focus and lock on click. The `/bot-card-demo.html` development route uses the same roster and selection behavior. The orbit stacks above the panels below 1200px; cards stack in stable order at 680px and below. Motion honors reduced-motion preferences. This is local UI state and makes no external connection. At narrow widths, interfaces stack and secondary sidebars collapse. Native app previews retain their light appearance in dark mode.

The page follows the prototype order: hero/demo, positioning, three capability columns, company stories, three Guides bullets, and five FAQ questions. Company tabs share the prototype’s single media/story panel and Kristine/Jonathan/Nat copy. The repeated X/Y FAQ questions are prototype placeholders. CompanyA has no supplied URL, so its link is disabled pending a destination. There is no installer or separate coworker-story section.

Company images are mapped in `src/sections.ts` to the matching user-supplied PNGs in `public/company-stories/`: `marcel.png`, `tobi.png`, and `jeff.png`. The original 1672 × 941 images are copied without transformation. The shared panel retains its responsive, uncropped sizing with `object-fit: contain`, descriptive alt text, intrinsic dimensions, lazy loading, and asynchronous decoding.

No backend or external font service is required. Asset sources are listed in `public/attributions.html`. Full license texts and copyright notices are collected in `public/third-party-notices.txt`; Vite copies both files into the website build. When adding or replacing an external asset, update its source entry and the corresponding notice. Font and icon licenses also remain alongside their existing source files.

Validation: `pnpm --filter @klex/website build`, `pnpm --filter @klex/website typecheck`, `pnpm exec biome check apps/website`, `pnpm format`, `pnpm format:check`, and `git diff --check`. Structure and copy were compared with the cached Figma node export for frame `1:134`; pixel fidelity has not been verified.
