import type { Duplex } from 'node:stream';

import type {
  DesktopInputAction,
  DesktopInputControl,
} from './input-control.js';
import { DesktopControlLease } from './lease.js';
import {
  type AccessibilityElement,
  type AccessibilityQuery,
  type AccessibilityTree,
  type DesktopCapabilities,
  type DesktopProvider,
  type DesktopWindow,
  type ImageFormat,
  type MouseButton,
  NO_DESKTOP,
  type Point,
  type Region,
  type ScreenSize,
  type ScrollDirection,
} from './provider.js';

/** Screenshots fit this box so model-facing coordinates stay stable. */
export const MAX_SCREENSHOT_SIZE: ScreenSize = { width: 1280, height: 800 };
const PROBE_RETRY_MS = 10_000;
const PROBE_REFRESH_MS = 60_000;
const DEFAULT_SETTLE_MS = 300;
const MAX_SETTLE_MS = 5_000;
export const DEFAULT_TREE_DEPTH = 30;
export const MAX_TREE_DEPTH = 60;
export const DEFAULT_TREE_NODES = 300;
export const MAX_TREE_NODES = 1_000;
const MAX_TREE_CHARACTERS = 24_000;
const MAX_REFS = 10_000;
const FRAME_ONLY_HINT =
  'Only the window itself is exposed. The app may not support accessibility, or, for Chrome and Electron apps, was started without --force-renderer-accessibility. Use desktop_screenshot.';

export interface DesktopScreenshot {
  data: Buffer;
  mimeType: string;
  /** Screenshot size; every desktop coordinate uses this space. */
  width: number;
  height: number;
  /** Physical screen size. */
  screen: ScreenSize;
}

export interface DesktopZoom extends DesktopScreenshot {
  region: Region;
}

export interface DesktopAccessibilityTreeOptions {
  /** Window id from `listWindows()`; the focused window when omitted. */
  window?: string;
  /** A ref from an earlier tree, to read only its subtree. */
  ref?: string;
  interactiveOnly?: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

export interface DesktopAccessibilityTree {
  /** One line per element: ref, role, name, value, bounds and states. */
  text: string;
  nodes: number;
  truncated: boolean;
}

export interface DesktopElementClick {
  ref: string;
  /** Where the click landed, in screenshot coordinates. */
  x: number;
  y: number;
}

/** A ref the model holds that no longer matches a live element. */
export class StaleElementRefError extends Error {
  constructor(ref: string) {
    super(
      `${ref} is stale or unknown. Read the tree again with desktop_accessibility_tree.`,
    );
    this.name = 'StaleElementRefError';
  }
}

type AccessibleProvider = DesktopProvider &
  Required<Pick<DesktopProvider, 'accessibilityTree' | 'accessibilityElement'>>;

export interface DesktopServiceOptions {
  /** Defaults to a fresh lease, which also gates agent input. */
  lease?: DesktopControlLease;
  /** Replaces the lease as the agent input gate. */
  inputControl?: DesktopInputControl;
  maxScreenshotSize?: ScreenSize;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class DesktopService {
  readonly lease: DesktopControlLease;
  readonly #provider: DesktopProvider;
  readonly #inputControl: DesktopInputControl;
  readonly #max: ScreenSize;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #probe: Promise<DesktopCapabilities> | undefined;
  #probedAt = 0;
  #probeTtl = 0;
  #probing = false;
  #queue: Promise<unknown> = Promise.resolve();
  // Refs are short names for provider handles. They are never reused, so a
  // ref the model still holds cannot silently point at another element.
  readonly #refs = new Map<string, { handle: string; role: string }>();
  readonly #refByHandle = new Map<string, string>();
  #nextRef = 1;

  constructor(provider: DesktopProvider, options: DesktopServiceOptions = {}) {
    this.#provider = provider;
    this.lease = options.lease ?? new DesktopControlLease();
    this.#inputControl = options.inputControl ?? this.lease;
    this.#max = options.maxScreenshotSize ?? MAX_SCREENSHOT_SIZE;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * The provider's latest probe. A full result is re-checked every minute and
   * a partial one every few seconds, so a desktop that appears or goes away is
   * noticed without probing on every request.
   */
  capabilities(): Promise<DesktopCapabilities> {
    if (
      this.#probe &&
      (this.#probing || this.#now() - this.#probedAt < this.#probeTtl)
    )
      return this.#probe;
    const probe: Promise<DesktopCapabilities> = this.#provider
      .probe()
      .catch(() => NO_DESKTOP)
      .then((capabilities) => {
        if (this.#probe === probe) {
          this.#probing = false;
          this.#probedAt = this.#now();
          this.#probeTtl =
            capabilities.computerUse && capabilities.stream
              ? PROBE_REFRESH_MS
              : PROBE_RETRY_MS;
        }
        return capabilities;
      });
    this.#probe = probe;
    this.#probing = true;
    return probe;
  }

  /** Drops the cached probe, for callers that just saw a capability fail. */
  invalidate(): void {
    this.#probe = undefined;
    this.#probing = false;
  }

  /** Opens an RFB source for one viewer. */
  openStream(): Promise<Duplex> {
    return this.#provider.openStream();
  }

  screenshot(format: ImageFormat = 'jpeg'): Promise<DesktopScreenshot> {
    return this.#serial(() => this.#capture(format));
  }

  zoom(region: Region, format: ImageFormat = 'jpeg'): Promise<DesktopZoom> {
    return this.#serial(async () => {
      const screen = await this.#refreshScreen();
      const space = this.#space(screen);
      assertRegion(region, space);
      const physical = clampRegion(
        {
          x: Math.floor(region.x / space.scale),
          y: Math.floor(region.y / space.scale),
          width: Math.ceil(region.width / space.scale),
          height: Math.ceil(region.height / space.scale),
        },
        screen,
      );
      const fit = Math.min(
        this.#max.width / physical.width,
        this.#max.height / physical.height,
      );
      const size = {
        width: Math.max(1, Math.round(physical.width * fit)),
        height: Math.max(1, Math.round(physical.height * fit)),
      };
      const data = await this.#provider.capture({
        region: physical,
        size,
        format,
      });
      return { data, mimeType: mimeType(format), ...size, screen, region };
    });
  }

  click(
    principalId: string,
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void> {
    return this.#input(principalId, 'click', async (toScreen) =>
      this.#provider.click(toScreen(point), button, count, modifiers),
    );
  }

  drag(
    principalId: string,
    from: Point,
    to: Point,
    button: MouseButton,
  ): Promise<void> {
    return this.#input(principalId, 'drag', async (toScreen) =>
      this.#provider.drag(toScreen(from), toScreen(to), button),
    );
  }

  move(principalId: string, point: Point): Promise<void> {
    return this.#input(principalId, 'move', async (toScreen) =>
      this.#provider.move(toScreen(point)),
    );
  }

  scroll(
    principalId: string,
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    return this.#input(principalId, 'scroll', async (toScreen) =>
      this.#provider.scroll(toScreen(point), direction, amount),
    );
  }

  type(principalId: string, text: string): Promise<void> {
    return this.#input(principalId, 'type', () => this.#provider.type(text));
  }

  key(principalId: string, combos: string[]): Promise<void> {
    return this.#input(principalId, 'key', () => this.#provider.key(combos));
  }

  focusWindow(principalId: string, id: string): Promise<void> {
    return this.#input(principalId, 'focusWindow', () =>
      this.#provider.focusWindow(id),
    );
  }

  launch(
    principalId: string,
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<{ pid: number }> {
    return this.#input(principalId, 'launch', () =>
      this.#provider.launch({ command, args, ...(cwd ? { cwd } : {}) }),
    );
  }

  listWindows(): Promise<DesktopWindow[]> {
    return this.#serial(async () => {
      const space = this.#space(await this.#refreshScreen());
      const windows = await this.#provider.listWindows();
      return windows.map((window) => ({
        ...window,
        bounds: {
          x: Math.round(window.bounds.x * space.scale),
          y: Math.round(window.bounds.y * space.scale),
          width: Math.round(window.bounds.width * space.scale),
          height: Math.round(window.bounds.height * space.scale),
        },
      }));
    });
  }

  /**
   * The accessibility tree of a window or of an earlier ref's subtree, as
   * text with refs and bounds in screenshot coordinates.
   */
  accessibilityTree(
    options: DesktopAccessibilityTreeOptions = {},
  ): Promise<DesktopAccessibilityTree> {
    return this.#serial(async () => {
      const provider = this.#accessible();
      const root = options.ref ? this.#refEntry(options.ref).handle : undefined;
      const space = this.#space(await this.#refreshScreen());
      const query: AccessibilityQuery = {
        interactiveOnly: options.interactiveOnly ?? true,
        maxDepth: clampInt(
          options.maxDepth,
          DEFAULT_TREE_DEPTH,
          MAX_TREE_DEPTH,
        ),
        maxNodes: clampInt(
          options.maxNodes,
          DEFAULT_TREE_NODES,
          MAX_TREE_NODES,
        ),
        ...(options.window ? { window: options.window } : {}),
        ...(root ? { root } : {}),
      };
      let tree: AccessibilityTree;
      try {
        tree = await provider.accessibilityTree(query);
      } catch (error) {
        if (options.ref && /gone/i.test(String(error))) {
          throw new StaleElementRefError(options.ref);
        }
        throw error;
      }
      return this.#formatTree(tree, space.scale, !root);
    });
  }

  /**
   * Click the centre of an element from an earlier tree. The element is
   * re-read first, so a ref whose element went away or moved off screen fails
   * instead of clicking whatever is now at its old position.
   */
  clickElement(
    principalId: string,
    ref: string,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<DesktopElementClick> {
    return this.#serial(async () => {
      const provider = this.#accessible();
      const entry = this.#refEntry(ref);
      const screen = await this.#refreshScreen();
      const space = this.#space(screen);
      const element = await provider.accessibilityElement(entry.handle);
      if (!element || element.role !== entry.role) {
        throw new StaleElementRefError(ref);
      }
      const center = elementCenter(element);
      if (!center) {
        throw new Error(
          `${ref} has no on-screen position. Use desktop_screenshot and click by coordinates.`,
        );
      }
      if (
        center.x < 0 ||
        center.y < 0 ||
        center.x >= screen.width ||
        center.y >= screen.height
      ) {
        throw new Error(
          `${ref} is off screen. Scroll it into view, then read the tree again.`,
        );
      }
      // Same rule as #input: authorize after the last await.
      await this.#inputControl.authorize({ action: 'click', principalId });
      await this.#provider.click(center, button, count, modifiers);
      return {
        ref,
        x: Math.min(space.width - 1, Math.round(center.x * space.scale)),
        y: Math.min(space.height - 1, Math.round(center.y * space.scale)),
      };
    });
  }

  #accessible(): AccessibleProvider {
    const provider = this.#provider;
    if (!provider.accessibilityTree || !provider.accessibilityElement) {
      throw new Error('Accessibility is not available on this desktop');
    }
    return provider as AccessibleProvider;
  }

  #refEntry(ref: string): { handle: string; role: string } {
    const entry = this.#refs.get(ref);
    if (!entry) throw new StaleElementRefError(ref);
    return entry;
  }

  #refFor(element: AccessibilityElement): string {
    const known = this.#refByHandle.get(element.handle);
    if (known) {
      const entry = this.#refs.get(known);
      this.#refs.delete(known);
      // A ref keeps the role it was issued with, so a handle whose element
      // changed role gets a new ref and the old one reads as stale.
      if (entry?.role === element.role) {
        this.#refs.set(known, entry);
        return known;
      }
    }
    // Refs are kept in least-recently-printed order; evicting from the front
    // never drops one printed in the same response.
    while (this.#refs.size >= MAX_REFS) {
      const [oldest, entry] = this.#refs.entries().next().value ?? [];
      if (oldest === undefined || !entry) break;
      this.#refs.delete(oldest);
      if (this.#refByHandle.get(entry.handle) === oldest)
        this.#refByHandle.delete(entry.handle);
    }
    const ref = `r${this.#nextRef++}`;
    this.#refs.set(ref, { handle: element.handle, role: element.role });
    this.#refByHandle.set(element.handle, ref);
    return ref;
  }

  #formatTree(
    tree: AccessibilityTree,
    scale: number,
    wholeWindow: boolean,
  ): DesktopAccessibilityTree {
    const header = [
      tree.window !== undefined ? `window ${JSON.stringify(tree.window)}` : '',
      tree.application ? `application ${JSON.stringify(tree.application)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const lines = header ? [header] : [];
    let length = header.length;
    let truncated = tree.truncated;
    let count = 0;
    for (const node of tree.nodes) {
      const line = formatNode(node, this.#refFor(node), scale);
      if (length + line.length + 1 > MAX_TREE_CHARACTERS) {
        truncated = true;
        break;
      }
      lines.push(line);
      length += line.length + 1;
      count += 1;
    }
    if (wholeWindow && !truncated && tree.nodes.length <= 1)
      lines.push(FRAME_ONLY_HINT);
    if (truncated) {
      lines.push(
        '[truncated: pass a ref to read one subtree, or lower maxDepth]',
      );
    }
    return { text: lines.join('\n'), nodes: count, truncated };
  }

  /**
   * Run an action, wait for the UI to settle, then capture, with no other
   * desktop operation in between. `operation` must call one of this service's
   * methods synchronously so its job is queued ahead of the capture.
   */
  async withSettledScreenshot<T>(
    operation: () => Promise<T>,
    settleMs = DEFAULT_SETTLE_MS,
    format: ImageFormat = 'jpeg',
  ): Promise<{ value: T; screenshot: DesktopScreenshot }> {
    const result = operation();
    const screenshot = this.#serial(async () => {
      try {
        await result;
      } catch {
        return undefined;
      }
      await this.#sleep(Math.min(Math.max(settleMs, 0), MAX_SETTLE_MS));
      return this.#capture(format);
    });
    const [value, shot] = await Promise.all([result, screenshot]);
    if (!shot) throw new Error('Desktop action failed before its screenshot');
    return { value, screenshot: shot };
  }

  async #capture(format: ImageFormat): Promise<DesktopScreenshot> {
    const screen = await this.#refreshScreen();
    const space = this.#space(screen);
    const size = { width: space.width, height: space.height };
    const scaled = size.width !== screen.width || size.height !== screen.height;
    const data = await this.#provider.capture({
      format,
      ...(scaled ? { size } : {}),
    });
    return { data, mimeType: mimeType(format), ...size, screen };
  }

  async #input<T>(
    principalId: string,
    action: DesktopInputAction,
    operation: (toScreen: (point: Point) => Point) => Promise<T>,
  ): Promise<T> {
    return this.#serial(async () => {
      const screen = await this.#refreshScreen();
      const space = this.#space(screen);
      // Authorize when the action runs, not when it was queued, and after the
      // last await so a takeover cannot land between the check and the input.
      await this.#inputControl.authorize({ action, principalId });
      return operation((point) => {
        assertPoint(point, space);
        return {
          x: Math.min(screen.width - 1, Math.round(point.x / space.scale)),
          y: Math.min(screen.height - 1, Math.round(point.y / space.scale)),
        };
      });
    });
  }

  /** Re-read the geometry so resolution changes never use stale scaling. */
  #refreshScreen(): Promise<ScreenSize> {
    return this.#provider.screenSize();
  }

  #space(screen: ScreenSize): ScreenSize & { scale: number } {
    const scale = Math.min(
      1,
      this.#max.width / screen.width,
      this.#max.height / screen.height,
    );
    return {
      scale,
      width: Math.round(screen.width * scale),
      height: Math.round(screen.height * scale),
    };
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

function formatNode(
  node: AccessibilityTree['nodes'][number],
  ref: string,
  scale: number,
): string {
  const parts = [`${'  '.repeat(node.depth)}${ref} ${node.role}`];
  parts.push(JSON.stringify(node.name));
  if (node.value !== undefined)
    parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.bounds) {
    const { x, y, width, height } = node.bounds;
    parts.push(
      `@${Math.round(x * scale)},${Math.round(y * scale)} ${Math.max(1, Math.round(width * scale))}x${Math.max(1, Math.round(height * scale))}`,
    );
  }
  if (node.states.length > 0) parts.push(`[${node.states.join(', ')}]`);
  return parts.join(' ');
}

function elementCenter(element: AccessibilityElement): Point | undefined {
  const bounds = element.bounds;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

function clampInt(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function mimeType(format: ImageFormat): string {
  return format === 'png' ? 'image/png' : 'image/jpeg';
}

function assertPoint(point: Point, space: ScreenSize): void {
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x >= space.width ||
    point.y >= space.height
  ) {
    throw new Error(
      `Coordinates (${point.x}, ${point.y}) are outside the ${space.width}x${space.height} screenshot`,
    );
  }
}

function assertRegion(region: Region, space: ScreenSize): void {
  assertPoint(region, space);
  if (
    region.x + region.width > space.width ||
    region.y + region.height > space.height
  ) {
    throw new Error(
      `Region exceeds the ${space.width}x${space.height} screenshot`,
    );
  }
}

function clampRegion(region: Region, screen: ScreenSize): Region {
  const x = Math.min(region.x, screen.width - 1);
  const y = Math.min(region.y, screen.height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(region.width, screen.width - x)),
    height: Math.max(1, Math.min(region.height, screen.height - y)),
  };
}
