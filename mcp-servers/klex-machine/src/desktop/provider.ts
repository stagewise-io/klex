import type { Duplex } from 'node:stream';

/**
 * Provider-independent desktop contract. Coordinates are physical screen
 * pixels; the service maps them to and from the model-facing screenshot space.
 */
export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type ImageFormat = 'jpeg' | 'png';

export interface Point {
  x: number;
  y: number;
}

export interface Region extends Point {
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** Physical region to capture. The whole screen when omitted. */
  region?: Region;
  /** Output size. The captured size when omitted. */
  size?: ScreenSize;
  format: ImageFormat;
}

export interface DesktopWindow {
  id: string;
  title: string;
  bounds: Region;
  focused: boolean;
}

export interface LaunchOptions {
  command: string;
  args: string[];
  cwd?: string;
}

/** What a desktop can do right now. Tools and streaming follow this alone. */
export interface DesktopCapabilities {
  /** Screenshots and input work: the desktop_* tools are offered. */
  computerUse: boolean;
  /** An RFB source can be opened: the desktop is offered to Cloud viewers. */
  stream: boolean;
  /** Physical screen size; always set with `computerUse`, when known otherwise. */
  screen?: ScreenSize;
}

export const NO_DESKTOP: DesktopCapabilities = {
  computerUse: false,
  stream: false,
};

/**
 * One platform's desktop: computer use and the stream source. Implementations
 * must satisfy test/desktop-provider-contract.ts.
 */
export interface DesktopProvider {
  /** Never rejects; an unusable desktop reports `NO_DESKTOP`. */
  probe(): Promise<DesktopCapabilities>;
  /** Current physical size, re-read before input so resolution changes apply. */
  screenSize(): Promise<ScreenSize>;
  capture(options: CaptureOptions): Promise<Buffer>;
  click(
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void>;
  drag(from: Point, to: Point, button: MouseButton): Promise<void>;
  move(point: Point): Promise<void>;
  scroll(
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void>;
  type(text: string): Promise<void>;
  key(combos: string[]): Promise<void>;
  listWindows(): Promise<DesktopWindow[]>;
  focusWindow(id: string): Promise<void>;
  launch(options: LaunchOptions): Promise<{ pid: number }>;
  /**
   * Opens a new connection to an RFB 3.x server for one viewer. It must allow
   * shared sessions and security type None. Rejects when `stream` is false.
   */
  openStream(): Promise<Duplex>;
}
