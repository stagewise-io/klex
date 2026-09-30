# @stagewise/ui

Customized [shadcn/ui](https://ui.shadcn.com) components built on [Base UI](https://base-ui.com) primitives, with a dynamic OKLCH color system and derived color utilities.

## Workspace usage

Add the package to the consuming workspace app:

```json
{
  "dependencies": {
    "@stagewise/ui": "workspace:*"
  }
}
```

### Peer dependencies

```bash
pnpm add react react-dom tailwindcss@^4
```

## Setup

### 1. Import the stylesheet

In your app's main CSS file (the one that imports `tailwindcss`):

```css
@import "tailwindcss";
@import "@stagewise/ui/style.css";

/* Required: tells Tailwind to scan component source files for class names */
@source "@stagewise/ui/src";
```

That single `@import` loads everything:

- The OKLCH color palette and theme tokens (light/dark)
- Bundled Geist Variable font (woff2, weights 100–900, upright + italic)
- The shadcn bridge layer (semantic token mappings)
- Derived color utilities (`border-derived`, `bg-hover-derived`, etc.)
- The `tailwindcss-color-modifiers` plugin (auto-loaded via `@plugin`)
- `tw-animate-css` animation utilities (`animate-in`, `fade-in-0`, `zoom-in-95`, etc.)

No separate `@config` file or plugin configuration is needed.

### Fonts

Geist Variable is bundled directly in the package — no `@fontsource` packages or `<link>` tags needed. The `@font-face` declarations are included in `style.css` and the woff2 files are served from the package.

The following Tailwind font tokens are set by default:

| Token | Value |
|-------|-------|
| `font-sans` | `"Geist Variable", ui-sans-serif, system-ui, sans-serif` |
| `font-heading` | `"Geist Variable", ui-sans-serif, system-ui, sans-serif` |
| `font-mono` | `ui-monospace, "SF Mono", "Cascadia Code", monospace` |

To use a different typeface, override the tokens after the import:

```css
@import "@stagewise/ui/style.css";

@theme inline {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-heading: "Inter", ui-sans-serif, system-ui, sans-serif;
}
```

### 2. Dark mode

The package uses `.dark` class on a root element (typically `<html>`) for dark mode. A no-FOUC script is recommended:

```html
<script>
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark')
  }
</script>
```

### 3. Optional: Custom hue and chroma

The color system is driven by CSS custom properties. Override them at `:root`:

```css
:root {
  --H: 265;              /* primary hue (0-360) */
  --H-base: 85;          /* neutral/base hue */
  --primary-chroma-scale: 1;  /* 0-2, scale primary chroma */
  --base-chroma-scale: 1;     /* 0-2, scale neutral chroma */
}
```

## Usage

```tsx
import { Button, Dialog, DialogTrigger, DialogContent } from "@stagewise/ui"

export function Example() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Open</Button>
      </DialogTrigger>
      <DialogContent>Content</DialogContent>
    </Dialog>
  )
}
```

## Icons

Icons are available via the `@stagewise/ui/icons` subpath export:

```tsx
import { IconChevronDownFill18, IconXmarkFill18 } from "@stagewise/ui/icons"
```

## Components

All shadcn/ui components from the `base-nova` style are re-exported, including: accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, bubble, button, button-group, calendar, card, carousel, chart, checkbox, collapsible, combobox, command, context-menu, dialog, direction, drawer, dropdown-menu, empty, field, hover-card, input, input-group, input-otp, item, kbd, label, marker, menubar, message, native-select, navigation-menu, pagination, popover, progress, questionnaire, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, spinner, switch, table, tabs, textarea, toast, toggle, toggle-group, tooltip.

Also exports the `cn` utility and `useIsMobile` hook.

## License

The package code (components, plugin, styles, utilities) is licensed under
**MIT**.

This package bundles third-party assets under separate licenses:

| Asset | Directory | License |
|-------|-----------|---------|
| Geist Variable font | `src/fonts/` | SIL Open Font License 1.1 (`src/fonts/OFL.txt`) |
| Nucleo icons | `src/icons/nucleo/` | Proprietary — restricted to stagewise GmbH products (`src/icons/nucleo/LICENSE.md`) |

The Nucleo icons are **not open source**. They may only be used in products
owned by stagewise GmbH. If you are not building a stagewise product, you
must remove or replace the Nucleo icons before redistributing this package.
