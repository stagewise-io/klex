# Connections and data-location diagrams

Korra's editable SVGs are published from ../../public/images/: mcp-wide.svg, mcp-compact.svg, data-wide.svg, and data-compact.svg. This folder retains the rendering source, palette, mark, Geist font and its license. The diagrams illustrate an app connection and data location; the adjacent documentation explains account permissions and hosting details.

To regenerate, use Node 24 or later here: npm install, npx playwright install chromium, then npm run render. On Linux Chromium may need additional system libraries. Review the exports in the docs at desktop and mobile widths and in both themes. Copy the four selected grid SVGs into ../../public/images/; rendering does not update them automatically.
