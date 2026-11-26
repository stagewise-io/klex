# Desktop stream helper protocol

klex-machine serves desktop streams with its own RFB server
(`src/desktop/rfb/`). On macOS and Windows a native helper captures the
screen, injects input and watches the clipboard. This document is the contract
between that helper and the daemon. The helpers are the Swift
`klex-desktop-helper stream` command on macOS and the C# stream host started
through PowerShell on Windows. The daemon side is
`src/desktop/platform/stream-helper.ts`.

The daemon runs one helper per capture. A capture runs while at least one
viewer is connected. The helper's stdin carries commands. Its stdout carries
the ready line, then binary messages. Stderr is free-form diagnostics, and the
daemon reports its last line when the helper exits unexpectedly.

## Version

This is version **1**.

Bump the version for any change a peer built for the previous version would
misread. That covers new or changed message types, payload layouts, commands,
key token forms, and the meaning of existing fields. The daemon refuses a
helper that announces another version, so the helper and the daemon always
ship together.

## Startup

The helper may print anything on stdout before the ready line. A shell
bootstrap, for example, may print a banner. The daemon skips at most 64 KiB
before it gives up. The ready line is ASCII:

```text
klex-stream-ready 1\n
```

Everything after the `\n` is binary messages. The helper sends the ready line
only after its capture and input are set up. Within a few seconds it then
sends `SIZE`, every tile, and `FRAME`. The daemon fails a capture that sends
no `SIZE` within 30 seconds.

## Helper to daemon: messages

Each message is:

| Field   | Size     | Value                       |
| ------- | -------- | --------------------------- |
| type    | 1 byte   | message type                |
| length  | 4 bytes  | payload length, big-endian  |
| payload | `length` | depends on the type         |

Integers are big-endian. The daemon fails the capture when a payload exceeds
64 MiB. It ignores unknown types, but within one version every type in use
must be listed here.

| Type | Name        | Payload                                         |
| ---- | ----------- | ----------------------------------------------- |
| 1    | `SIZE`      | u16 width, u16 height                           |
| 2    | `RAW`       | u16 x, u16 y, u16 width, u16 height, pixels     |
| 3    | `JPEG`      | u16 x, u16 y, u16 width, u16 height, JPEG file  |
| 4    | `FRAME`     | empty                                           |
| 5    | `CLIPBOARD` | UTF-8 text                                      |
| 6    | `LOG`       | UTF-8 text                                      |

### Framebuffer and tiles

`SIZE` sets the framebuffer size in pixels, from 1 to 16384 on each side. It
comes before the first tile and again whenever the desktop changes size. After
each `SIZE`, the next frame must contain every tile.

The framebuffer is a grid of 128 by 128 pixel tiles that starts at the
top-left corner. Tiles in the last column and row are clipped to the
framebuffer. A tile message always covers exactly one grid cell. The daemon
fails the capture on any other rectangle.

`RAW` pixels are 4 bytes each, ordered B, G, R, and an ignored byte. Rows run
top-down with no padding, so the payload has `8 + width * height * 4` bytes.

`JPEG` carries a baseline JFIF image of exactly the tile's size. The helper
sends JPEG only while the daemon has set a quality. It should send a tile
again as `RAW` after the tile has stayed unchanged for a moment, so still
content ends up lossless.

Tiles take effect together at the next `FRAME`. A helper sends only tiles that
changed since the last frame, except right after `SIZE` or `refresh`.

### Clipboard

`CLIPBOARD` reports the desktop clipboard's text. The helper sends it once at
startup if the clipboard holds text, and again whenever the text changes. It
must not echo text set with the `clipboard` command, although the daemon
tolerates one echo. The daemon drops text over 1 MiB.

## Daemon to helper: commands

Commands are UTF-8 lines ending in `\n`, with fields separated by single
spaces. The helper ignores unknown commands and malformed lines. When stdin
closes, the helper releases anything it holds and exits. If it is still
running three seconds later, the daemon kills it.

| Command                              | Meaning                                    |
| ------------------------------------ | ------------------------------------------ |
| `quality <q>`                        | JPEG quality 1 to 100, or 0 for none       |
| `refresh`                            | send every tile as `RAW` in the next frame |
| `move <x> <y>`                       | move the pointer                           |
| `button <name> <1\|0> <x> <y>`       | press or release `left`, `middle`, `right` |
| `wheel <direction> <x> <y>`          | scroll one step `up`, `down`, `left`, `right` |
| `key <1\|0> <token>`                 | press or release a key                     |
| `clipboard <base64>`                 | set the clipboard to base64 UTF-8 text     |

The initial quality is 0. Coordinates are framebuffer pixels. A `move` comes
before any `button` or `wheel` at a new position, but every command carries
its own position anyway. Press and release arrive as separate commands. The
helper passes them on as they are and never synthesizes a click.

### Key tokens

Tokens are chosen by the daemon's per-platform key mapping. All numbers are
lowercase hexadecimal.

| Token     | Platform | Meaning                                              |
| --------- | -------- | ---------------------------------------------------- |
| `k<code>` | macOS    | virtual key code (`kVK_*`), with modifier tracking   |
| `s<code>` | Windows  | set 1 scan code                                      |
| `e<code>` | Windows  | extended (E0-prefixed) set 1 scan code               |
| `v<code>` | Windows  | virtual-key code, for keys without a scan code       |
| `u<code>` | both     | a Unicode code point for keys with no physical code  |

## Changes

- Version 1: first version.
