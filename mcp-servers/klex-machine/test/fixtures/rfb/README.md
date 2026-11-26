# RFB test vectors

Data for the RFB server tests in `test/rfb-*.test.ts`. The files are plain
data, so any implementation of the server can be checked against them.

## Frames

`<name>.bgrx.gz` files are gzip-compressed framebuffers: 4 bytes per pixel in
the order B, G, R, unused, rows top-down without padding. This is the pixel
layout of the helper stream protocol (`native/stream-protocol.md`).

`frames.json` describes each frame:

- `width` and `height` in pixels.
- `after`: the frame shown before this one, when the frame tests an update.
- `tight`: for each changed 128-pixel tile, keyed `x,y`, the Tight
  sub-encoding a lossless server picks. `fill` is a single colour, `mono` a
  two-colour palette, `palette` 3 to 256 colours, and `full` full-colour zlib.
  A frame with `after` lists only the tiles that differ from that frame.

`generate.mjs` documents how the frames were made. The files are the source of
truth, so don't regenerate them unless you mean to change the vectors.

## Traffic

`novnc-*.json` files record a real noVNC session against klex-machine's
server, with a synthetic capture showing one of the frames above. Each holds:

- `frame`: the frame the capture showed. noVNC rendered it pixel for pixel.
- `client`: the WebSocket messages noVNC sent, as hex, in order.
- `input`: the capture commands the server derived from them, in the
  notation of `SyntheticCapture` in `test/rfb-test-client.ts`. Keys are
  `key <down> <keysym hex> <XT keycode>`; `clipboard <text>` is text the viewer
  provided.

`novnc-1.7.0-session.json` was recorded with
`pnpm preview:stream --synthetic --record <file>` and noVNC 1.7.0 in Chrome:
a click, a wheel step, `a`, Enter, ArrowLeft, then a paste of
`Grüße ✓ from noVNC` with Ctrl+V.
