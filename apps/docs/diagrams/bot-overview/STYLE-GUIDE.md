# Klex docs diagrams — proposed visual style v4

Revised for Knuth and Glenn, 9 November 2026, following feedback1794237161.775409,1794237194.287929 compact-routing correction1794237641.730109, and continuous-grid request1794238544.161119. Proposal only: not an approved brand standard and not added to the docs.

## Recommendation
Use a quiet, scope-first technical illustration: one clearly labelled pale-blue Bot environment contains the Klex Bot and Memory. Two independent blue MCP connections lead from the Bot to a computer and an app outside it. The original Klex mark provides the signature; diagram labels use Geist for legibility rather than campaign-sized serif headlines.

This is a conceptual architecture diagram, not a product screenshot or a deployment/security diagram. The boundary expresses runtime/memory scope, not a claim of sandbox isolation. The computer and app are connected work environments, not components of the Bot environment. The connector badges identify MCP; they are not additional servers, agents, gateways, or mandatory centralized services.

### Source and intentional omissions
Semantic source: https://github.com/stagewise-io/klex/blob/8f320838ecc26c66a50119fa1640535308d21bec/apps/docs/docs/bot/concepts/01-how-bots-work.mdx
The pinned page is included as docs-how-bots-work.mdx.

- The Bot environment runs the Bot and manages its memory. It is not the Bot's workspace.
- Memory currently stores skills and learnings. The diagram does not imply a universal knowledge store or that chats are its only contents.
- Computers and apps are both connected through MCP. The internal Bot–Memory relationship is deliberately not marked MCP.
- The Bot has its own identity. The image does not specify authentication mechanisms, grants, or universal access.
- Hosting is intentionally neutral. Nothing here implies that Cloud hosting/enrollment is required for self-hosting.
- Active-session management, chat storage, permission details, and individual MCP servers are left to their dedicated pages. No icons imply third-party partnerships.

## Reusable grammar

1. **Scope first.** A named, tinted rounded container means containment. Place all contained nodes fully inside. Never use a boundary merely as decoration. Label external work clearly.
2. **Node cards.** Warm near-white fill, 2px neutral border at the source viewBox size, 18px corner radius. Use a short noun label with at most one source-backed helper line. Avoid decorative shadows and gradients.
3. **Connections.** Use 3.5px brand-blue smooth Bézier connections for MCP and place an MCP label on each distinct connection. Use a neutral 3px line for an internal relation. This Overview uses no arrowheads: these lines show connectivity, not data-flow direction. Add arrows only when a future diagram actually defines direction. Use horizontal/vertical tangents at joins; never add a sharp elbow. Avoid ambiguous crossings and shared hubs unless the architecture has one.
4. **Icons.** Use one restrained outline vocabulary, 2.5px stroke at source size. Computer = monitor, app = application window, memory = store. The unchanged official unframed Klex mark identifies the Bot. The storage icon is a conceptual memory cue, not a claim about database implementation.
5. **Typography.** Geist, actual bundled variable face. Node labels 28–32px, helper text 24px in the wide composition; compact helper text 26–28px. Medium labels, regular helper lines. Use live text in editable SVG. Reserve Fraunces for surrounding editorial headings where appropriate, not every technical label.
6. **Space.** Start from an 8px rhythm, with generous container padding and optical adjustments. Route labels away from card titles. Do not mechanically repeat a layout if the next concept requires another arrangement.
7. **Colour has meaning.** Blue identifies MCP and the Bot scope; dark ink carries labels. Labels, position and borders must still explain the relationships without colour. Do not encode permissions, trust, success or risk solely by hue.

## Palette provenance
All diagram-layout colours are resolved from the supplied palette.css snapshot, originally sources/stagewise-ui/package/src/styles/palette.css in the studio (published @stagewise/ui 0.14.0). The renderer verifies every referenced token before rendering, resolves it in an sRGB browser, and writes exact values and contrast ratios to tokens.json. Do not replace these with guessed hex colours.

| Role | Source token |
|---|---|
| Opaque canvas / cards | --color-base-50 |
| Main labels / outline icons | --color-base-900 |
| Helper text | --color-base-500 |
| Card borders | --color-base-250 |
| Internal relationship | --color-base-350 |
| Bot-environment fill | --color-brand-50 |
| Environment border | --color-brand-150 |
| MCP connections / labels | --color-brand-500 |
| Optional background grid | --color-base-200 at 35% opacity |

Fixed brand tokens avoid unintentionally adopting a personalized primary hue. The original logo's own SVG colours are preserved rather than recoloured. This proposal is light artwork with its own opaque backplate; retain that backplate in dark docs. Do not apply a CSS invert filter. A theme-native dark version would need a separately tested semantic palette.

## Continuous background grid (V4)

The faint grid continues behind all unboxed headings and MCP labels. No white backing rectangles, local grid masks or text halos. Actual environment/node cards retain opaque fills because they are meaningful containers.

The grid remains decorative: base-200 at 35% opacity, 32px wide / 40px compact pitch, 1px strokes. Text sits directly over it. Body/helper/MCP text contrast is checked against the conservative darkest grid stroke as well as the canvas.

Only the blue connector stroke is masked where an MCP label sits, making a short line gap without masking the background grid. Paths retain the exact smooth wide and non-crossing V3 mobile geometry. Matching no-grid exports are included.

## Wide and narrow layouts

- overview-wide.svg: 1200×640 editable vector; overview-wide@2x.png: 2400×1280.
- overview-mobile.svg: 640×970 editable vector; overview-mobile@2x.png: 1280×1940.
- The default files include the grid; matching overview-wide-no-grid and overview-mobile-no-grid SVGs/PNGs are also supplied.
- The mobile version is a genuine recomposition, not a squeezed crop. Its external computer/app cards are below the environment. Both layouts have exactly the same meaning.
- Prefer SVG for docs if the site permits it. All fonts/artwork are embedded; no remote assets or scripts are required. PNG is the compatibility fallback.
- Switch according to **available article width**, not just viewport width: wide at roughly 640px and above; compact below. Render at width:100%; height:auto. Do not upscale PNG beyond its intrinsic resolution.
- At 720px article width, the wide helper text is equivalent to 14.4px. At 320px article width, compact node labels are equivalent to 14px. Actual embed previews are included. Recheck on the real docs page with its sidebar, zoom and mobile viewport before merging.

Possible container-query integration (adapt to the docs components):

~~~html
<div class="overview-diagram">
  <img class="overview-wide" src="/images/overview-wide.svg" alt="...same description below..." width="1200" height="640" />
  <img class="overview-compact" src="/images/overview-mobile.svg" alt="...same description below..." width="640" height="970" />
</div>
~~~

~~~css
.overview-diagram { container-type: inline-size; }
.overview-diagram img { width: 100%; height: auto; }
.overview-diagram .overview-wide { display: none; }
@container (min-width: 640px) {
  .overview-diagram .overview-wide { display: block; }
  .overview-diagram .overview-compact { display: none; }
}
~~~

Display:none keeps the inactive duplicate out of the accessibility tree. Use the full real alt text, not the placeholder. Retain the page's explanatory paragraphs: an image must not become the only source of the architecture description. The SVG also contains title and desc, but an HTML img still needs its own alt.

### Suggested alt text
A Klex Bot and its memory are inside the Bot environment, which runs the Bot and manages memory. Memory currently holds skills and learnings. Separate MCP connections link the Bot to a connected computer and a connected app outside the Bot environment, where its work happens. Lines show connections, not the direction of data flow.

## Editing and regeneration

SVGs are the primary editable deliverables: named cards, grouped icons, paths, live labels, embedded licensed font, and embedded original logo. Open directly in a modern browser or vector editor. Some vector importers ignore embedded webfonts; install Geist before editing and recheck text bounds. The renderer uses editable coordinate primitives, not a flattened screenshot.

For regeneration: Node 24 tested; npm install; npx playwright install chromium; npm run render. Playwright also needs its standard OS dependencies (or an existing supported local sysroot). No sudo or OS package change is performed by this source. The Korra-specific LD_LIBRARY_PATH fallback in render.mjs is inert on other machines; KLEX_SYSROOT can point to a custom library directory. Only playwright and sharp are needed. Regeneration resets the generated visual-review status; inspect new outputs again.

Included: render.mjs, package.json, palette.css snapshot, tokens.json, original klex-unframed.svg, geist-variable.woff2 and Geist-OFL.txt, all four editable SVGs, PNGs and embed previews, pinned page source and manifest.json. The font remains under its included SIL OFL; Klex artwork retains its original ownership. No blanket ownership/license claim is made over third-party assets.

## V3 compact routing fix

Knuth found the V2 mobile wires crossed near the Bot. Corrected by preserving lane ordering: the upper Bot port now feeds the outer/right rail and connected app; the lower port feeds the inner rail and connected computer. The routes never cross, touch, or share a hub. All curves join with horizontal or vertical tangents. Both MCP labels stay on straight runs. In the V3 routing fix, wide exports were unchanged from V2; V4 now revises only grid pixels in the old text-clearance areas. Explicit sampled-path intersection/clearance checks supplement appearance review.

For future diagrams, preserve port/lane ordering through bends and test route intersections before delivery; a visible crossing must not accidentally imply a junction.

## Revision scope

Glenn’s positive response to the direction was relayed by Knuth; this does not approve docs integration or the new grid. The wide node positions, copy, palette and typography remain unchanged. MCP wires are now smooth curves. In the compact layout, rounded turns keep the wires outside the runtime/memory scope; MCP labels sit on the horizontal wire runs rather than the bends. The grid is a new decorative layer only.

## Review and handoff

Technical checks cover: source token existence, font loading, text/card bounds, internal containment, external-node separation, exactly two MCP connectors, opaque PNG dimensions and text contrast. Contrast ratios are recorded in tokens.json (all tested label/background combinations exceed 4.5:1). Thin structural borders are not used as the only cue to meaning.

Direct exported-PNG appearance review is recorded in manifest.json after inspection. That is separate from Knuth/Glenn's semantic and design approval. Actual docs integration, live responsive/theme rendering, and publication are not performed in this proposal.

Suggested review question: Does this make the distinction between *where the Bot runs/remembers* and *where it works* immediately clear? If yes, reuse this grammar for the Connections and Memory diagrams rather than copying every coordinate.

## V4 revision scope

Requested by Knuth1794238544.161119 on Glenn’s feedback. Remove heading grid-clearance mask and opaque MCP label backgrounds. Use transparent MCP text with a mask on connector strokes only. Preserve node/copy/label positions, curve paths, palette and grid strength. V4 actual-export appearance review passed (recorded in manifest.json). Docs-theme testing and review by Knuth/Glenn remain pending.
