---
name: Klex
description: A warm, precise, and approachable system for an intelligent digital coworker.
colors:
  signal-blue: "oklch(0.5455 0.25 265)"
  warm-paper: "oklch(0.992 0.001 85)"
  soft-paper: "oklch(0.96 0.0015 85)"
  near-black-ink: "oklch(0.198 0.0005 85)"
  graphite: "oklch(0.46 0.0045 85)"
  quiet-line: "oklch(0.92 0.002 85)"
  dark-canvas: "oklch(0.234 0.001 85)"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(3.25rem, 8vw, 7.5rem)"
    fontWeight: 560
    lineHeight: 0.94
    letterSpacing: "-0.065em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  compact-display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(3.25rem, 16vw, 5rem)"
    fontWeight: 560
    lineHeight: 0.94
    letterSpacing: "-0.065em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  heading-xl:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(2.75rem, 4.5vw, 4rem)"
    fontWeight: 560
    lineHeight: 0.98
    letterSpacing: "-0.045em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  heading-xl-mobile:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(2.5rem, 12vw, 3.5rem)"
    fontWeight: 560
    lineHeight: 0.98
    letterSpacing: "-0.045em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  heading-lg:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(1.5rem, 2.5vw, 2rem)"
    fontWeight: 540
    lineHeight: 1.1
    letterSpacing: "-0.03em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  heading-sm:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 560
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "'WONK' 0, 'opsz' 0"
  lead:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1rem, 1.5vw, 1.125rem)"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  ui-sm:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
  brand:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
  footer:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1
rounded:
  control: "0.5rem"
  container: "0.75rem"
  emblem: "0.75rem"
  focus: "0.125rem"
  dot: "999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2.5rem"
  section: "5rem"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.warm-paper}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.625rem"
    height: "2rem"
    typography: "{typography.label}"
  input:
    backgroundColor: transparent
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.control}"
    padding: "0.25rem 0.625rem"
    height: "2rem"
    typography: "{typography.body}"
  card:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.container}"
    padding: "1rem"
    typography: "{typography.body}"
---

# Design System: Klex

## Overview

**Creative North Star: "The Helpful Robot"**

Klex should feel intelligent without feeling difficult. Fraunces gives the brand a thoughtful, human voice; Geist and the stagewise UI foundation keep every interaction direct, legible, and familiar. The result is warm, precise, approachable, intelligent, and human.

The system is honest and open rather than mysterious or theatrical. It should communicate that a capable autonomous coworker is present while hiding unnecessary machinery. Simple wins: hierarchy comes from type, spacing, a restrained warm-neutral palette, and one clear signal accent rather than decorative effects.

**Key Characteristics:**

- Warm and trustworthy, not sterile.
- Intelligent and editorial, not academic.
- Simple and explicit, not simplistic.
- Flat and honest, with functional depth only where needed.
- Consistent with the shadcn-based `@stagewise/ui` component system.

## Colors

The palette uses warm, extremely low-chroma neutrals with one vivid signal accent. The normative values come from `@stagewise/ui`; Klex should consume its semantic variables rather than recreate local brand values.

### Primary

- **Signal Blue:** Primary actions, active states, links, focus indicators, and the small status signal. Its rarity makes it useful.

### Neutral

- **Warm Paper:** Default content canvas in the light theme.
- **Soft Paper:** Secondary surface and app-level separation.
- **Near-Black Ink:** Primary text and high-emphasis marks.
- **Graphite:** Supporting copy and metadata.
- **Quiet Line:** Low-contrast dividers and structural borders.
- **Dark Canvas:** Dark-theme canvas supplied by the shared UI system.

**The One Signal Rule.** Use the primary accent to communicate action, focus, or status. Do not spread it across large decorative surfaces.

**The Shared Palette Rule.** Prefer `@stagewise/ui` semantic variables such as `--color-background`, `--color-foreground`, and `--color-primary-solid`; do not hard-code parallel Klex values.

## Typography

**Display Font:** Fraunces (with Georgia fallback)  
**Body Font:** Geist Variable (with system UI fallback)

**Character:** Fraunces supplies intelligence, warmth, and an unmistakably human editorial quality. Geist makes interface language simple, neutral, and operationally clear.

### Hierarchy

- **Display:** Medium variable weight, tightly tracked, compact line height. Reserve it for the hero and other major page-level statements.
- **Title:** Fraunces at a restrained scale for section and card titles when an editorial voice is useful.
- **Body:** Geist Variable at a comfortable reading rhythm. Keep long copy near 60 characters per line.
- **Label:** Geist Variable with semibold weight and measured tracking for compact status, eyebrow, and metadata text.

**The Intelligent Serif Rule.** Fraunces is for meaning and hierarchy, not controls or dense operational copy.

**The Fixed Character Rule.** Set Fraunces with the wonk axis at zero and explicitly request the optical-size axis at zero while disabling automatic optical sizing. Browsers may clamp optical size to the font's published minimum.

## Layout

The website uses a centered, fluid shell with a maximum width of 73.75rem and 1.5rem side gutters. Header and footer form quiet horizontal rails around a vertically centered hero. Generous empty space communicates ease and confidence.

The hero is constrained to roughly 62.5rem, while its supporting copy stays near 37.5rem. Desktop composition relies on large vertical breathing room. Below 42.5rem, rails become shorter, gutters tighten to 1.25rem, display type scales down fluidly, and the footer stacks without changing reading order.

**The One Clear Thought Rule.** Each major viewport should have one dominant message and enough open space for it to read immediately.

## Elevation & Depth

The system is flat and honest. Spacing, typography, tonal surfaces, and quiet borders establish hierarchy. Shadows are not a default surface treatment; reserve them for functional overlays or a small state halo that would otherwise be ambiguous.

**The Flat-by-Default Rule.** Cards and controls remain visually grounded at rest. Interaction may change tone, border, or position by a single pixel, but should not turn the interface into floating glass.

## Shapes

Controls use gently rounded corners aligned with the shared shadcn-based component kit. Containers are slightly softer than controls, while brand emblems may use the same container radius. Circular forms are reserved for compact status indicators.

Borders are thin and low contrast. Avoid novelty silhouettes, oversized pills for ordinary actions, or mixed corner systems within the same surface.

## Components

### Buttons

- **Shape:** Gently rounded and compact, with a two-rem default height.
- **Primary:** Signal accent fill with high-contrast text; keep labels short and direct.
- **Hover / Focus:** Slight tonal shift on hover, one-pixel downward movement when active, and a visible shared-system focus ring.
- **Secondary / Ghost:** Use an honest border or tonal hover state instead of additional saturated fills.

### Cards / Containers

- **Corner Style:** Softly rounded container corners.
- **Background:** Semantic background or surface tokens from the shared kit.
- **Shadow Strategy:** No shadow at rest.
- **Border:** A quiet one-pixel ring where separation is required.
- **Internal Padding:** One-rem default rhythm, reduced only for compact variants.

### Inputs / Fields

- **Style:** Transparent fill, strong derived border, compact height, and Geist text.
- **Focus:** Shared accent border plus a visible focus ring.
- **Error / Disabled:** Use the shared semantic destructive and disabled states rather than Klex-specific exceptions.

### Navigation

Navigation is typography-led and minimal. Use Geist for labels, semantic text colors, and an underline or tonal state for hover and active feedback. Keep the brand lockup visually stronger than utility links. On small screens, preserve clarity before density.

### Status Indicator

The status pattern pairs a small circular signal with a compact uppercase-style label. The signal may use a restrained halo, but it should remain secondary to the page's primary message.

## Do's and Don'ts

### Do:

- **Do** use Fraunces to make major statements feel intelligent and human.
- **Do** use Geist Variable and shared shadcn patterns to keep interaction simple.
- **Do** consume semantic tokens and components from `@stagewise/ui`.
- **Do** create hierarchy with whitespace, type, quiet borders, and restrained tonal changes.
- **Do** keep keyboard focus visible and motion compatible with reduced-motion preferences.

### Don't:

- **Don't** duplicate the shared palette with local hard-coded approximations.
- **Don't** use saturated accent color as general decoration.
- **Don't** add ornamental gradients, glass effects, or persistent shadows to make simple surfaces feel impressive.
- **Don't** use Fraunces for controls, dense metadata, or long operational copy.
- **Don't** expose technical complexity when a familiar, obvious interaction will do.
