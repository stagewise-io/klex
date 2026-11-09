# Bot Overview diagram source

The editable SVGs used by the docs are `../../public/images/bot-overview-wide.svg` and `../../public/images/bot-overview-compact.svg`. Korra’s renderer, palette, logo, Geist font and license are kept here so the diagrams can be revised. `STYLE-GUIDE.md` is the original design proposal and refers to optional exports not checked into this directory.

## Visual reference

For future docs illustrations, use the V4 artwork as a style reference: its palette, typography, subtle continuous grid and smooth connectors. Prefer editable SVGs where appropriate. Adapt the composition to the subject; the compact vertical layout is not a prescribed pattern.

## Regeneration

To regenerate, use Node 24 or later in this directory: `npm install`, `npx playwright install chromium`, then `npm run render`. Review the results at desktop and mobile sizes in both docs themes. Copy the selected `overview-wide.svg` and `overview-mobile.svg` exports to the public image paths above; the generator does not update them automatically.
