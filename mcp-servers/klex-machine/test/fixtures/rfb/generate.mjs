// Regenerates the synthetic frames in this directory:
//   node test/fixtures/rfb/generate.mjs
// The frames are the source of truth for tests; this script only documents
// how they were made. See README.md for the formats.

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const here = new URL('.', import.meta.url);

/** Four tile kinds: fill, two colours, a small palette and full colour. */
function desktop(x, y) {
  if (x < 128 && y < 128) return 0x336699;
  if (y < 128) return (x + y) % 2 ? 0xffffff : 0x000000;
  if (x < 128) return [0xff0000, 0x00ff00, 0x0000ff, 0xffff00][(x >> 2) % 4];
  return (((x * 7) & 0xff) << 16) | (((y * 3) & 0xff) << 8) | ((x + y) & 0xff);
}

function changed(x, y) {
  return x >= 256 && y >= 128 ? 0x123456 : desktop(x, y);
}

function frame(name, width, height, color) {
  const bgrx = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bgrx.writeUInt32LE(color(x, y) & 0xffffff, (y * width + x) * 4);
    }
  }
  writeFileSync(new URL(`${name}.bgrx.gz`, here), gzipSync(bgrx, { level: 9 }));
}

frame('desktop-260x140', 260, 140, desktop);
frame('desktop-260x140-changed', 260, 140, changed);
frame('desktop-280x150', 280, 150, desktop);
