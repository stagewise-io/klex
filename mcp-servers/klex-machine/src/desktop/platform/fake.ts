import { appendFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

import type {
  AccessibilityElement,
  AccessibilityNode,
  AccessibilityQuery,
  AccessibilityTree,
  CaptureOptions,
  DesktopCapabilities,
  DesktopProvider,
  DesktopWindow,
  LaunchOptions,
  MouseButton,
  Point,
  Region,
  ScreenSize,
  ScrollDirection,
} from '../provider.js';
import {
  type StreamBackend,
  type StreamCapture,
  type StreamSink,
  STREAM_TILE_SIZE,
} from '../rfb/backend.js';
import { RfbServer } from '../rfb/index.js';

/**
 * Values of `KLEX_MACHINE_DESKTOP` that select the fake desktop: `fake` with
 * accessibility, `fake-basic` without it, `fake-unavailable` with only a hint.
 */
export const FAKE_DESKTOP_MODES = [
  'fake',
  'fake-basic',
  'fake-unavailable',
] as const;
export type FakeDesktopMode = (typeof FAKE_DESKTOP_MODES)[number];

export const FAKE_SCREEN: ScreenSize = { width: 1600, height: 1000 };
export const FAKE_UNAVAILABLE_HINT = 'The fake desktop is unavailable.';
export const FAKE_CLIPBOARD = 'fake clipboard';
const FAKE_PID = 4242;

/** The fake screen's colour at a pixel, as 0xRRGGBB. */
export function fakePixel(x: number, y: number): number {
  return (
    ((x & 0xff) << 16) | ((y & 0xff) << 8) | (((x >> 4) ^ (y >> 4)) & 0xff)
  );
}

interface FakeElement extends AccessibilityNode {
  interactive: boolean;
}

interface FakeWindowState extends DesktopWindow {
  application: string;
  elements: FakeElement[];
}

const element = (
  window: string,
  index: number,
  depth: number,
  role: string,
  name: string,
  bounds: Region,
  interactive: boolean,
  extra: { value?: string; states?: string[] } = {},
): FakeElement => ({
  handle: `${window}:${index}`,
  role,
  name,
  ...(extra.value !== undefined ? { value: extra.value } : {}),
  states: extra.states ?? [],
  bounds,
  depth,
  interactive,
});

function fakeWindows(): FakeWindowState[] {
  return [
    {
      id: '101',
      title: 'Fake editor',
      bounds: { x: 100, y: 50, width: 800, height: 600 },
      focused: true,
      application: 'Fake app',
      elements: [
        element(
          '101',
          0,
          0,
          'window',
          'Fake editor',
          { x: 100, y: 50, width: 800, height: 600 },
          true,
        ),
        element(
          '101',
          1,
          1,
          'button',
          'Save',
          { x: 120, y: 70, width: 80, height: 30 },
          true,
        ),
        element(
          '101',
          2,
          1,
          'label',
          'Untitled',
          { x: 220, y: 70, width: 200, height: 30 },
          false,
        ),
        element(
          '101',
          3,
          1,
          'textbox',
          'Search',
          { x: 120, y: 120, width: 300, height: 30 },
          true,
          { value: 'hello', states: ['focusable', 'editable'] },
        ),
        element(
          '101',
          4,
          2,
          'button',
          'Offscreen',
          { x: 2000, y: 2000, width: 50, height: 20 },
          true,
        ),
      ],
    },
    {
      id: '202',
      title: 'Fake terminal',
      bounds: { x: 900, y: 500, width: 600, height: 400 },
      focused: false,
      application: 'Fake shell',
      elements: [
        element(
          '202',
          0,
          0,
          'window',
          'Fake terminal',
          { x: 900, y: 500, width: 600, height: 400 },
          true,
        ),
      ],
    },
  ];
}

/**
 * A deterministic desktop for conformance tests, identical in both
 * klex-machine implementations. The screen is 1600x1000 with `fakePixel`
 * colours, captures are PNG whatever the format asks for, and every call is
 * appended as one JSON line to `KLEX_MACHINE_DESKTOP_FAKE_LOG` when set.
 */
export class FakeDesktopProvider implements DesktopProvider {
  readonly #mode: FakeDesktopMode;
  readonly #log: string | undefined;
  readonly #windows = fakeWindows();
  #stream: RfbServer | undefined;
  accessibilityTree?: (query: AccessibilityQuery) => Promise<AccessibilityTree>;
  accessibilityElement?: (
    handle: string,
  ) => Promise<AccessibilityElement | undefined>;

  constructor(mode: FakeDesktopMode, env: NodeJS.ProcessEnv = process.env) {
    this.#mode = mode;
    this.#log = env.KLEX_MACHINE_DESKTOP_FAKE_LOG || undefined;
    if (mode === 'fake') {
      this.accessibilityTree = async (query) => this.#tree(query);
      this.accessibilityElement = async (handle) => {
        const found = this.#element(handle);
        if (!found) return undefined;
        const { depth: _depth, interactive: _interactive, ...rest } = found;
        return rest;
      };
    }
  }

  async probe(): Promise<DesktopCapabilities> {
    if (this.#mode === 'fake-unavailable')
      return { computerUse: false, stream: false, hint: FAKE_UNAVAILABLE_HINT };
    return {
      computerUse: true,
      stream: true,
      ...(this.#mode === 'fake' ? { accessibility: true } : {}),
      screen: { ...FAKE_SCREEN },
    };
  }

  async screenSize(): Promise<ScreenSize> {
    return { ...FAKE_SCREEN };
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    this.#record({
      call: 'capture',
      region: options.region ?? null,
      size: options.size ?? null,
      format: options.format,
    });
    const region = options.region ?? { x: 0, y: 0, ...FAKE_SCREEN };
    const size = options.size ?? { width: region.width, height: region.height };
    const rgb = Buffer.alloc(size.width * size.height * 3);
    for (let y = 0; y < size.height; y++) {
      const sy = region.y + Math.floor((y * region.height) / size.height);
      for (let x = 0; x < size.width; x++) {
        const sx = region.x + Math.floor((x * region.width) / size.width);
        const color = fakePixel(sx, sy);
        const at = (y * size.width + x) * 3;
        rgb[at] = color >> 16;
        rgb[at + 1] = (color >> 8) & 0xff;
        rgb[at + 2] = color & 0xff;
      }
    }
    return encodePng(size, rgb);
  }

  async click(
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void> {
    this.#record({
      call: 'click',
      x: point.x,
      y: point.y,
      button,
      count,
      modifiers,
    });
  }

  async drag(from: Point, to: Point, button: MouseButton): Promise<void> {
    this.#record({ call: 'drag', from, to, button });
  }

  async move(point: Point): Promise<void> {
    this.#record({ call: 'move', x: point.x, y: point.y });
  }

  async scroll(
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    this.#record({ call: 'scroll', x: point.x, y: point.y, direction, amount });
  }

  async type(text: string): Promise<void> {
    this.#record({ call: 'type', text });
  }

  async key(combos: string[]): Promise<void> {
    this.#record({ call: 'key', keys: combos });
  }

  async listWindows(): Promise<DesktopWindow[]> {
    return this.#windows.map(({ id, title, bounds, focused }) => ({
      id,
      title,
      bounds: { ...bounds },
      focused,
    }));
  }

  async focusWindow(id: string): Promise<void> {
    this.#record({ call: 'focusWindow', id });
    if (!this.#windows.some((window) => window.id === id))
      throw new Error(`No window has id ${id}`);
    for (const window of this.#windows) window.focused = window.id === id;
  }

  async launch(options: LaunchOptions): Promise<{ pid: number }> {
    this.#record({
      call: 'launch',
      command: options.command,
      args: options.args,
      cwd: options.cwd ?? null,
    });
    return { pid: FAKE_PID };
  }

  async openStream(): Promise<Duplex> {
    if (this.#mode === 'fake-unavailable')
      throw new Error(FAKE_UNAVAILABLE_HINT);
    this.#stream ??= new RfbServer(
      new FakeStreamBackend((entry) => this.#record(entry)),
      { name: 'klex-machine fake desktop' },
    );
    return this.#stream.open();
  }

  #tree(query: AccessibilityQuery): AccessibilityTree {
    let window: FakeWindowState | undefined;
    let nodes: FakeElement[];
    if (query.root !== undefined) {
      const root = this.#element(query.root);
      if (!root) throw new Error(`The element ${query.root} is gone`);
      window = this.#windows.find((candidate) =>
        candidate.elements.includes(root),
      );
      const elements = window?.elements ?? [];
      const start = elements.indexOf(root);
      let end = start + 1;
      while (
        end < elements.length &&
        (elements[end] as FakeElement).depth > root.depth
      )
        end++;
      nodes = elements
        .slice(start, end)
        .map((node) => ({ ...node, depth: node.depth - root.depth }));
    } else {
      window =
        query.window === undefined
          ? this.#windows.find((candidate) => candidate.focused)
          : this.#windows.find((candidate) => candidate.id === query.window);
      if (!window) throw new Error(`No window has id ${query.window}`);
      nodes = window.elements.map((node) => ({ ...node }));
    }
    const kept = nodes.filter(
      (node) =>
        node.depth < query.maxDepth &&
        (node.depth === 0 || node.interactive || !query.interactiveOnly),
    );
    return {
      ...(window
        ? { application: window.application, window: window.title }
        : {}),
      nodes: kept
        .slice(0, query.maxNodes)
        .map(({ interactive: _interactive, ...node }) => node),
      truncated: kept.length > query.maxNodes,
    };
  }

  #element(handle: string): FakeElement | undefined {
    for (const window of this.#windows) {
      const found = window.elements.find((node) => node.handle === handle);
      if (found) return found;
    }
    return undefined;
  }

  #record(entry: Record<string, unknown>): void {
    if (this.#log) appendFileSync(this.#log, `${JSON.stringify(entry)}\n`);
  }
}

/** Sends the fake screen as raw tiles and records stream input. */
class FakeStreamBackend implements StreamBackend {
  constructor(readonly record: (entry: Record<string, unknown>) => void) {}

  start(sink: StreamSink): StreamCapture {
    let stopped = false;
    const sendAll = () => {
      if (stopped) return;
      for (let y = 0; y < FAKE_SCREEN.height; y += STREAM_TILE_SIZE) {
        for (let x = 0; x < FAKE_SCREEN.width; x += STREAM_TILE_SIZE) {
          const tile = {
            x,
            y,
            width: Math.min(STREAM_TILE_SIZE, FAKE_SCREEN.width - x),
            height: Math.min(STREAM_TILE_SIZE, FAKE_SCREEN.height - y),
          };
          const pixels = Buffer.alloc(tile.width * tile.height * 4);
          for (let row = 0; row < tile.height; row++) {
            for (let column = 0; column < tile.width; column++) {
              pixels.writeUInt32LE(
                fakePixel(x + column, y + row),
                (row * tile.width + column) * 4,
              );
            }
          }
          sink.raw(tile, pixels);
        }
      }
      sink.frame();
    };
    setImmediate(() => {
      if (stopped) return;
      sink.resize({ ...FAKE_SCREEN });
      sendAll();
      if (!stopped) sink.clipboard(FAKE_CLIPBOARD);
    });
    return {
      setQuality: () => undefined,
      refresh: () => setImmediate(sendAll),
      move: (x, y) => this.record({ call: 'stream.move', x, y }),
      button: (button, down, x, y) =>
        this.record({ call: 'stream.button', button, down, x, y }),
      wheel: (direction, x, y) =>
        this.record({ call: 'stream.wheel', direction, x, y }),
      key: (key) =>
        this.record({
          call: 'stream.key',
          down: key.down,
          keysym: key.keysym,
          keycode: key.keycode,
        }),
      setClipboard: (text) => this.record({ call: 'stream.clipboard', text }),
      stop: () => {
        stopped = true;
      },
    };
  }
}

/** An 8-bit RGB PNG with unfiltered rows. */
function encodePng(size: ScreenSize, rgb: Buffer): Buffer {
  const rowBytes = size.width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * size.height);
  for (let y = 0; y < size.height; y++)
    rgb.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size.width, 0);
  header.writeUInt32BE(size.height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
