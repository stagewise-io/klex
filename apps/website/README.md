# Klex marketing website

Static Vite marketing demo. Run `pnpm --filter @klex/website dev` from the repository root.

The landing page extends `DESIGN.md` and `PRODUCT.md`: warm shared UI tokens, locally served Fraunces headings, bundled Geist Variable UI text, and a restrained blue action color. The hero contains illustrative Slack, Gmail, Google Calendar, and GitHub examples. Klex Bot is always a separate participant. These examples do not assert that those connectors ship with Klex.

Connector tabs support click, Enter/Space, Left/Right arrows, Home, and End, with roving tab stops and individually associated panels. Preview controls that are only visual context are noninteractive. At narrow widths, secondary app sidebars collapse while conversation content remains available. Native app previews retain their light appearance when the surrounding page follows the system dark theme.

The installer retains platform selection and copy feedback. No backend or external font service is required. Asset provenance is listed in `public/attributions.html`; connector SVGs are copied unchanged from the existing Simple Icons dependency. No Slack mark was available, so Slack uses its name as a selector label, without a fabricated mark.

Validation: `pnpm --filter @klex/website build`, `pnpm --filter @klex/website typecheck`, `pnpm exec biome check apps/website`, `pnpm format`, `pnpm format:check`, and `git diff --check`. Browser verification is intentionally excluded for this task. The supplied Figma URL could not be accessed, so exact Figma fidelity has not been verified.
