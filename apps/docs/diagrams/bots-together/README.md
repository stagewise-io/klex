# Bots working together illustration

Korra's editable source for the collaboration guide. The published SVGs are in `apps/docs/public/images/`. Use the wide composition at a container width of 640px or more, and the compact composition below that. Both use an opaque light panel in light and dark themes.

The separate blue routes show Bots joining a shared conversation; they do not represent access grants, ordering, a direct Bot-to-Bot connection, or shared memory. The surrounding guide explains messaging connections and account access.

## Regeneration

`render.mjs` generates SVGs in this directory, along with PNG previews and QA metadata. In a Node environment with Chromium's system dependencies installed, run `npm install`, `npx playwright install chromium`, then `npm run render` in this directory. Copy the generated SVGs to `apps/docs/public/images/` to update the docs. The generator reads the included palette, Geist font, and Klex mark; the font license is in `Geist-OFL.txt`. Klex branding is supplied for authorized Klex docs use.

Regeneration changes the reviewed exports; check the actual built guide at desktop and mobile sizes in both themes and obtain a fresh scoped visual review. The original delivered kit and its full QA records are at `/workspace/marketing-studio/output/klex-docs-bots-together-v1/` on Korra's machine.
