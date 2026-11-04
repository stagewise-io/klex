# Website agent discovery

## Build and verification

```sh
pnpm --filter @klex/website build
pnpm --filter docs build
pnpm exec vitest run apps/website scripts/agent-site
pnpm --filter docs run doctor
pnpm format
pnpm format:check
```

The artifact tests require both builds first. Preview marketing with `pnpm --filter @klex/website preview`; preview docs with `node scripts/agent-site/preview.mjs docs --port 4174`. Vite development remains the interactive frontend development server; protocol checks use the built preview, not Vite dev.

## Content contract

The marketing origin is `https://www.klex.bot`. Its inventory is discovered automatically from emitted HTML files containing semantic main content (currently `/`, `/brand`, and `/press`); assets and the error page are excluded. This discovers pages emitted by the framework build, not unregistered source templates. Brand and press retain their intentional noindex policy. Markdown is extracted from the prerendered semantic main content, excluding hidden/decorative SVG, scripts, styles and navigation. FAQ button labels remain content. No duplicate manually maintained marketing copy is required.

The build emits Markdown mirrors, llms files, an informational agent-readability manifest, robots, a host-scoped sitemap and linked Organization/SoftwareApplication JSON-LD. The agent-readability manifest is an informational document, not a claimed standard API schema. The real OpenAPI contract remains Blume's generated read-only docs specification. Marketing redirects `/openapi.json` to that specification and advertises it in HTML and HTTP links. No bot execution or authenticated admin endpoint is exposed.

Dates come from committed source history, not build time. Docs route mapping removes numeric ordering prefixes and uses the English source for Blume's untranslated fallback routes. A missing source/history mapping fails the build instead of inventing a date. Deployment must include Git history for the content files. For shallow exports, supply history or introduce explicit editorial timestamps before deployment.

## Automatic generation and exclusions

Each normal app build runs generation after Vite/Blume. Marketing uses rendered HTML; docs uses Blume's page index and generated Markdown, including locale fallback pages. New emitted content pages enter discovery automatically. Never hand edit generated artifacts.

Configure `apps/website/discovery.config.json` and `apps/docs/discovery.config.json`. Both start with empty arrays to preserve current policies:

```json
{
  "sitemap": ["/example-page"],
  "agents": ["/internal/**"],
  "markdown": ["/draft/*"]
}
```

- `sitemap`: omit matching canonical routes from the XML sitemap. Existing HTML noindex is always respected on marketing pages.
- `agents`: omit routes from llms index/full text, agent manifest lists, and the docs aggregate page index. HTML and directly addressed JSON remain public.
- `markdown`: omit `.md`/`.mdx` mirrors and marketing Markdown negotiation/alternate links. Agent full text is a separate surface: exclude from `agents` too if it must not contain that page. Docs page-index entries for disabled mirrors are omitted to avoid advertising nonexistent Markdown URLs.

Patterns match canonical pathnames: exact `/page`, `*` within one segment, and `**` across segments. Locale routes must be matched explicitly (e.g. `/de/internal/**`). Queries are not patterns. Invalid configuration fails the build. Exclusions do not hide navigation, feeds, directly addressed JSON, search indexes, linked content, or HTML; they are not access controls or robots/training policy. Use authentication for private information. Run a full clean app build after changing policy, not the postprocessor alone; the framework recreates the artifact inventory first.

Marketing emits a private build diagnostic at `.vercel/output/content-report.json`: meaningful main-text characters, raw HTML size, SVG size, H1 count and heading skips. The ratio is explicitly a diagnostic, not a reproduction of Ora's undocumented calculation. Static office polygon/polyline runs are now extracted automatically into a content-hashed same-origin SVG sprite served with one-year immutable caching. External use references preserve paint order and inherited theme variables; bot portal hosts, human figures, React islands and animated artwork remain inline. Homepage HTML drops by about 114 KB (roughly 27%); the 5% text ratio target is not yet met.

## Progressive animated mascots

The 11 prerendered animated feature mascots now render cached image placeholders on the server and the first client render. IntersectionObserver upgrades them near the viewport using a lazy-loaded runtime component. Suspense/error boundaries retain the image when loading is pending or fails; reduced motion retains the image. Reserved dimensions avoid layout collapse. On-ready callbacks restore current pause/resume, speech and reaction state, and the tool conveyor waits for the live handle before issuing movement commands. Hero/workflow/office mascots were already runtime-mounted and remain unchanged.

Local browser checks confirmed all 11 placeholders upgrade to live rigs near the viewport, and all return to loaded static images under reduced motion. Raw curl response: 105,347 HTML characters, 38 SVG elements, 11 progressive placeholders, no animated actor markup. This is about 48% smaller than the preceding 204 KB build and 75% smaller than the original 427 KB HTML. Semantic text remains 3,995 characters. Remaining SVGs are small icons, simple Slack avatars and the office wrapper. Full pixel-equivalence comparison is still outstanding.

## Further static artwork extraction

Additional office human-figure groups, non-hydrated SVG bodies, collaboration avatars, provider icons and hosting desk geometry now live in external hashed SVG files. Small inline SVG shells retain theme inheritance, paint order and animated lights. Hydrated SVGs are changed at the component source rather than rewritten only in HTML. Vite asset inlining is disabled; hashed SVG/CSS/JS/font assets use one-year immutable cache headers. HTML is about 81.6 KB with 9.9 KB remaining SVG markup (including shells), versus 105.3 KB/34.5 KB before this pass. Semantic text remains unchanged. External XML generation normalizes HTML-style boolean data attributes to valid XML.

## Static mascot assets

The Vite static-mascot plugin renders package artwork at build time, emits content-hashed SVG files, and exposes the same asset map to SSR and client code through a virtual module. Comparison-table mascots and static identity-card avatars use image references; animation-driven mascots remain inline. Thirteen image instances share four used assets (five variants generated). These assets receive one-year immutable caching through the production routing configuration. Build tests verify shape content, shadow, retrieval and cache headers. HTML is now about 204 KB, down from 315 KB before this step and 427 KB before office extraction; inline SVG count is 60 rather than 86. Asset loading and DOM dimensions were checked in the local browser; full visual equivalence is not claimed.

## Routing and cache policy

Both builds produce Vercel Build Output API v3 artifacts. Configure the projects with their respective app directories as project roots, include files outside those roots, and run the app's build script. The repository requires Node 26 for builds; the dependency-free function targets Vercel's Node 24 runtime. Confirm both settings in the real projects before deploying. Do not deploy only the static dist directory: negotiated responses and structured errors require the generated function and routes.

The local preview interprets the generated route inventory and invokes the **packaged** function entrypoint. It is an integration harness, not a substitute for Vercel preview validation. Actual provider rewrite behavior, original request paths, aliases, runtime support and CDN handling remain deployment acceptance checks.

Marketing HTML routes support HTML and Markdown using Accept media ranges and quality values. Exact exclusions override wildcards; quality ties and an absent/wildcard Accept prefer HTML. Unsupported representations return 406. Explicit Markdown mirrors remain available independently. Errors retain 404, negotiate HTML/Markdown/problem JSON, and include recovery guidance. API misses always use RFC 9457 problem JSON. HEAD returns the GET headers without its body; mutations receive 405 with Allow.

Negotiated HTML/Markdown and dynamic errors use `Cache-Control`, `CDN-Cache-Control`, and `Vercel-CDN-Cache-Control: no-store`, plus `Vary: Accept`. This deliberately sacrifices CDN HTML caching to avoid cross-representation cache pollution. Static assets remain static. Revisit caching only after proving variant isolation on the real CDN.

## Audit outcomes and remaining acceptance checks

| Finding | Local implementation / remaining work |
| --- | --- |
| 1: Markdown 404 | Implemented and HTTP tested. |
| 2: Raw HTML content | Manual browser checks with scripting disabled confirm visible homepage text and all six FAQ answers on desktop/mobile. FAQ no-script cascade fixed; closed answers included in Markdown. Static office geometry externalized; remaining SVG markup and the reported 5% ratio remain partial. |
| 3: JSON errors | RFC 9457 errors implemented; checked against the published docs Problem schema. |
| 4: Homepage negotiation | Implemented and HTTP tested, including quality values, HEAD and alternating representations. |
| 5: Brand search | Product terms added to truthful JSON-LD; existing product-qualified title retained. Ranking not measured or guaranteed. |
| 6: JSON-LD | Linked SoftwareApplication and publisher Organization generated. |
| 7: When to use | Marketing llms and docs build augmentation describe prerequisites, suitable uses and limits. |
| 8–9: API discovery and tools | Existing docs OpenAPI advertised; operation IDs, references, concrete responses and every indexed page tested. Tool generators must handle nested route path parameters and OpenAPI 3.1/JSON Schema constructs; this is not a bot-action API. |
| 10: Sitemap | Marketing indexable URLs only; docs stays on docs host. Source-derived dates added. |
| 11: Organization completeness | Verified stagewise GmbH publisher and support@klex.bot customer-support ContactPoint added. PostalAddress omitted at owner request; the full scanner check remains partial. |
| 12: Metadata | Canonical/social URLs aligned to www in source and generated HTML; noindex preserved. |

All production outcomes remain unverified until owner-authorized deployment. Required follow-ups:

- Verify Vercel project roots, Node build/runtime settings and Build Output routing on a protected preview, then production. Alternate HTML/Markdown in both orders and inspect final statuses, Content-Type, Vary, cache headers and bodies through the actual CDN.
- Verify the apex-to-www redirect preserves requests, paths and queries without loops/chains; no DNS/domain configuration was changed.
- Repeat all advertised discovery and docs endpoint checks against the deployment. Re-run the original Ora/Is Agentic audit; no new score is claimed.
- Postal address remains intentionally skipped. Hosting verification is skipped for now at owner request. Cloud frontend work is handled separately.
- No-JavaScript desktop/mobile checks now pass: visible H1, 5,358 main-text characters, all six FAQ panels visible; mobile has no horizontal overflow at 390px. Markdown homepage/mirror return 200 with 4,397 characters; missing Markdown route returns true 404. Normal scripting/device settings were restored. Full theme/interaction visual comparison remains outstanding; screenshot files were captured but image inspection was unavailable.
- Obtain the referenced Cloud frontend guidance before further UI changes.
- Use owner-provided Search Console access for canonical/indexing inspection, sitemap submission and a dated query/market/device baseline. Search rank is an observed follow-through outcome, not a code acceptance guarantee.
