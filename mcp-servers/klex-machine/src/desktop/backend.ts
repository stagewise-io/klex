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

export interface DesktopBackend {
  /** Rejects when the display or required tooling is unavailable. */
  probe(): Promise<ScreenSize>;
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
}
