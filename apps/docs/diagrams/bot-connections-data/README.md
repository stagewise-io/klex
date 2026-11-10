# Connections and data-location diagrams

Korra's connection SVGs are published from ../../public/images/: mcp-wide.svg and mcp-compact.svg. The data-location artwork in this older renderer is superseded; use ../bot-data-location/ for its current source. This folder retains the rendering source, palette, mark, Geist font and its license. The diagrams illustrate an app connection and data location; the adjacent documentation explains account permissions and hosting details.

To regenerate, use Node 24 or later here: npm install, npx playwright install chromium, then npm run render. On Linux Chromium may need additional system libraries. Review the exports in the docs at desktop and mobile widths and in both themes. Copy the two selected MCP SVGs into ../../public/images/; do not copy the superseded data SVGs; rendering does not update them automatically.
