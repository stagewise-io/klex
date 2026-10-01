# Brand and press resources

Mode: Read. Audience: newsrooms, partners, and people using Klex assets.

## Direction contract

THESIS: A practical reference, with naming and product truth before reusable assets; no campaign hero or invented press coverage.

OWN-WORLD: Inherit the live site's Fraunces headings, Geist body, shared neutral palette, compact header, and quiet footer. Preview assets on fixed contrasting backgrounds.

STORY: Understand the product vocabulary, read the description, choose a logo, and download its SVG. Press readers get product depth and sourced company background.

FIRST VIEWPORT: Shared header, Brand/Press navigation, large left-aligned title, concise introduction, and section links or a brand-kit link.

FORM: User-pinned section order; directly shaped reference pages, no concept seed needed. Signature interaction: immediate native SVG downloads.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Sources: existing brand vectors and UI palette; https://company.stagewise.io and https://company.stagewise.io/company for company background and founders. No new rasters.

## Finish review

Reviewer and documentation roles were performed inline because this environment has no subagent capability.

Disposition: ship.

### persistence

PRODUCT.md and DESIGN.md exist. The pages extend the incumbent neutral palette, Fraunces/Geist pairing, navigation, and footer without changing the visual identity. DESIGN.md is intentionally preserved rather than silently regenerated; implementation-specific resource documentation is in README.md.

### fidelity

- TYPE: match; incumbent Fraunces headings and Geist reading text, with a quieter reference-page scale.
- MATERIAL: match; flat reference content, vector brand assets, no fabricated texture or physical effects.
- GROUND: match; shared semantic background in both themes; fixed base-50 and base-950 asset preview grounds.
- STORY: match; naming, short description, logos, colors in the requested order; press copy followed by company background and founders.
- FIRST VIEWPORT: match; page-level heading, short introduction, and useful navigation without an additional marketing callout.
- FORM: match; native SVG links, paired theme previews, readable definitions and color values.

### ceiling

The reference-page reading mode uses editorial hierarchy, section dividers, restrained surfaces, and native downloads. Additional motion, depth, and ornament would compete with the task.

### material_fixes

None remaining. A descending-specificity lint warning was resolved without a visual change. The malformed press captures caused by overlapping capture workflows were discarded; only the valid, correctly sized captures below were reviewed.

### keep

Preserve the fixed-theme logo previews, the exact naming rules, and the separation between product summary and sourced company facts.

### Evidence

Valid full-page captures reviewed: att/brand-desk_kf5un1ju.png (1440px), att/brand-mobi_iemo292k.png (390px), att/brand-dark_w7t3xmng.png (1440px); att/press-desk_vdwkmvpq.png (1440px), att/press-mobi_l8l1c6f6.png (390px), att/press-dark_ncrug0bk.png (1440px). Both pages show the document top, requested content, and footer. Runtime checks found no horizontal overflow or browser errors; direct routes with and without trailing slash and every SVG source returned HTTP 200.

### Documentation summary

- Palette: existing neutral tokens and primary-500, with source OKLCH and rounded sRGB equivalents.
- Type: existing Fraunces/Geist, reference-page display and section headings above comfortable reading copy.
- Rules: reuse palette tokens; preserve naming and asset proportions; preview themes explicitly.
- Layout: label/content columns and paired assets on desktop, stable single-column order on mobile.
- States: underlined current page, native downloads, shared keyboard-focus styling.

Not canonized: task-specific reference-page spacing and the omission of the homepage’s closing CTA are local choices, not new global system rules.
