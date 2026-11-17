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

export interface AccessibilityQuery {
  /** Window id from `listWindows()`; the focused window when omitted. */
  window?: string;
  /** Element handle whose subtree to read instead of a whole window. */
  root?: string;
  /** Keep only controls a user can act on, plus the root. */
  interactiveOnly: boolean;
  maxDepth: number;
  maxNodes: number;
}

/** One element of an accessibility tree, in physical screen pixels. */
export interface AccessibilityElement {
  /** Opaque and provider-defined; valid while the element lives. */
  handle: string;
  /** Lower-case role name such as `push button` or `entry`. */
  role: string;
  name: string;
  /** Text or numeric value; never set for password fields. */
  value?: string;
  /** Normalized names such as `focused`, `checked` or `disabled`. */
  states: string[];
  /** Absent when the element has no on-screen geometry. */
  bounds?: Region;
}

export interface AccessibilityNode extends AccessibilityElement {
  /** Depth among the returned nodes; the root is 0. */
  depth: number;
}

export interface AccessibilityTree {
  application?: string;
  /** Title of the window the tree belongs to, when known. */
  window?: string;
  /** Pre-order: each node follows its parent. */
  nodes: AccessibilityNode[];
  /** Some nodes were left out by a depth, size or time limit. */
  truncated: boolean;
}

/** What a desktop can do right now. Tools and streaming follow this alone. */
export interface DesktopCapabilities {
  /** Screenshots and input work: the desktop_* tools are offered. */
  computerUse: boolean;
  /** An RFB source can be opened: the desktop is offered to Cloud viewers. */
  stream: boolean;
  /**
   * Accessibility trees can be read and elements targeted. Opt-in per
   * provider; it adds the accessibility tools only alongside `computerUse`.
   */
  accessibility?: boolean;
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
  /** Required when `probe()` reports `accessibility`. */
  accessibilityTree?(query: AccessibilityQuery): Promise<AccessibilityTree>;
  /**
   * Re-reads one element, or resolves undefined once it is gone. Required when
   * `probe()` reports `accessibility`.
   */
  accessibilityElement?(
    handle: string,
  ): Promise<AccessibilityElement | undefined>;
  /**
   * Opens a new connection to an RFB 3.x server for one viewer. It must allow
   * shared sessions and security type None. Rejects when `stream` is false.
   */
  openStream(): Promise<Duplex>;
}
