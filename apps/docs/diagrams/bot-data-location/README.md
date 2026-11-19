# Data-location diagram

Korra’s editable SVGs are published as ../../public/images/data-wide.svg and data-compact.svg. This directory contains the renderer, palette, mark, Geist font and license. The cloud and generic server are conceptual hosting locations, not infrastructure or security boundaries. The surrounding page explains the details.

To regenerate, use Node 24 or later here: npm install, npx playwright install chromium, then npm run render. Linux Chromium may require additional system libraries. Rendering does not update the published SVGs automatically; review new exports in the docs at desktop and mobile widths and in both themes before copying them to ../../public/images/. A new render requires fresh visual review.
