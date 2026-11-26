// A stand-in for the native stream helpers that speaks
// native/stream-protocol.md, sending a fixture frame and reporting every
// command it receives as a LOG message.
//
// FAKE_STREAM_VERSION overrides the announced protocol version.
// FAKE_STREAM_EXIT makes it exit with that code after the first frame.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';

const TILE = 128;
const width = 260;
const height = 140;
const pixels = gunzipSync(
  readFileSync(new URL('./rfb/desktop-260x140.bgrx.gz', import.meta.url)),
);

function send(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
}

function u16(...values) {
  const out = Buffer.alloc(values.length * 2);
  for (const [i, value] of values.entries()) out.writeUInt16BE(value, i * 2);
  return out;
}

function sendFrame() {
  for (let y = 0; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) {
      const w = Math.min(TILE, width - x);
      const h = Math.min(TILE, height - y);
      const rows = [];
      for (let row = 0; row < h; row++) {
        const at = ((y + row) * width + x) * 4;
        rows.push(pixels.subarray(at, at + w * 4));
      }
      send(2, Buffer.concat([u16(x, y, w, h), ...rows]));
    }
  }
  send(4);
}

// What a shell might print before the helper takes over.
process.stdout.write('PS C:\\Windows\\System32> ');
process.stdout.write(
  `klex-stream-ready ${process.env.FAKE_STREAM_VERSION ?? '1'}\n`,
);
send(1, u16(width, height));
sendFrame();
send(5, Buffer.from('from the fake desktop ✓'));
if (process.env.FAKE_STREAM_EXIT) {
  process.stderr.write('fake helper failure\n');
  process.exit(Number(process.env.FAKE_STREAM_EXIT));
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  send(6, Buffer.from(line.length > 200 ? 'preamble' : line));
  if (line === 'refresh') sendFrame();
});
lines.on('close', () => process.exit(0));
