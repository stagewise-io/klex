import type { Duplex } from 'node:stream';

import type {
  DesktopInputAction,
  DesktopInputControl,
} from './input-control.js';
import { DesktopControlLease } from './lease.js';
import {
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
