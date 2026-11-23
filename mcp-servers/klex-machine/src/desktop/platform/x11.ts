import { execFile, spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  type AccessibilityElement,
  type AccessibilityQuery,
  type AccessibilityTree,
  type CaptureOptions,
  type DesktopCapabilities,
  type DesktopProvider,
  type DesktopWindow,
  type LaunchOptions,
  type MouseButton,
  NO_DESKTOP,
  type Point,
  type ScreenSize,
  type ScrollDirection,
} from '../provider.js';
import {
  AtspiClient,
  type AtspiConnector,
  connectAtspiBus,
  withTimeout,
} from './atspi.js';

export const DEFAULT_VNC_SOCKET_PATH = '/run/klex/vnc.sock';
const STREAM_CONNECT_TIMEOUT_MS = 2_000;

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_WINDOWS = 50;
const TYPE_CHUNK_CHARACTERS = 200;
const JPEG_QUALITY = 75;

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number },
) => Promise<Buffer>;

export type ProcessLauncher = (
  options: LaunchOptions & { env: NodeJS.ProcessEnv },
) => Promise<{ pid: number }>;

export type SocketConnector = (path: string) => Socket;

export interface X11DesktopProviderOptions {
  /** X display such as `:1`. Without one, the provider reports no desktop. */
  display?: string;
  env?: NodeJS.ProcessEnv;
  /** Unix socket of a VNC server for this display, such as Xvnc's `-rfbunixpath`. */
  vncSocketPath?: string;
  run?: CommandRunner;
  launch?: ProcessLauncher;
  connect?: SocketConnector;
  /** D-Bus connector for the accessibility and session buses. */
  connectBus?: AtspiConnector;
}

const NO_TREE_HINT =
  'GTK and Qt apps expose one once accessibility is on, but only if they were started after it was enabled; Chrome and Electron apps also need --force-renderer-accessibility. Use desktop_screenshot instead.';

const BUTTONS: Record<MouseButton, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

const SCROLL_BUTTONS: Record<ScrollDirection, string> = {
  up: '4',
  down: '5',
  left: '6',
  right: '7',
};

const KEY_ALIASES: Record<string, string> = {
  alt: 'alt',
  option: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  cmd: 'super',
  command: 'super',
  win: 'super',
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page_Up',
  page_up: 'Page_Up',
  pagedown: 'Page_Down',
  page_down: 'Page_Down',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  plus: 'plus',
  minus: 'minus',
};

const MODIFIERS = new Set(['alt', 'ctrl', 'shift', 'super']);
const KEYSYM = /^[A-Za-z0-9_]{1,32}$/;

/** Map a generic combo such as `Ctrl+Shift+T` or `cmd+l` to an xdotool keysym chord. */
export function toXdotoolCombo(combo: string): string {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === '')) {
    throw new Error(`Invalid key combo: ${combo}`);
  }
  return parts
    .map((part) => {
      const alias = KEY_ALIASES[part.toLowerCase()];
      if (alias) return alias;
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) return part.toUpperCase();
      if (part.length === 1 || KEYSYM.test(part)) return part;
      throw new Error(`Unsupported key name: ${part}`);
    })
    .join('+');
}

export function toXdotoolModifier(modifier: string): string {
  const mapped = KEY_ALIASES[modifier.toLowerCase()];
  if (!mapped || !MODIFIERS.has(mapped)) {
    throw new Error(`Unsupported modifier: ${modifier}`);
  }
  return mapped;
}

const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString('utf8').trim().split('\n').at(-1);
          reject(
            new Error(
              `${file} failed${detail ? `: ${detail}` : `: ${error.message}`}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

const launchProcess: ProcessLauncher = ({ command, args, cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      if (child.pid === undefined) reject(new Error('Process has no PID'));
      else resolve({ pid: child.pid });
    });
  });

/**
 * X11 desktop: input and windows through xdotool, capture through ImageMagick
 * `import`, and the stream from a VNC server's Unix socket. Computer use needs
 * a reachable display and both tools; streaming needs only a live socket for
 * the configured display.
 */
export class X11DesktopProvider implements DesktopProvider {
  readonly #display: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #vncSocketPath: string;
  readonly #run: CommandRunner;
  readonly #launch: ProcessLauncher;
  readonly #connect: SocketConnector;
  readonly #atspi: AtspiClient;

  constructor(options: X11DesktopProviderOptions = {}) {
    this.#display = options.display?.trim() || undefined;
    this.#env = { ...(options.env ?? process.env), DISPLAY: this.#display };
    this.#vncSocketPath = options.vncSocketPath ?? DEFAULT_VNC_SOCKET_PATH;
    this.#run = options.run ?? runCommand;
    this.#launch = options.launch ?? launchProcess;
    this.#connect = options.connect ?? ((path) => connect(path));
    const connectBus = options.connectBus ?? connectAtspiBus;
    this.#atspi = new AtspiClient({
      address: () => this.#atspiAddress(connectBus),
      connect: connectBus,
    });
  }

  async probe(): Promise<DesktopCapabilities> {
    if (!this.#display) return NO_DESKTOP;
    const [screen, capture, stream, accessibility] = await Promise.all([
      this.screenSize().catch(() => undefined),
      this.#exec('import', ['-version']).then(
        () => true,
        () => false,
      ),
      this.#connectStream().then(
        (socket) => {
          socket.destroy();
          return true;
        },
        () => false,
      ),
      this.#atspi.available(),
    ]);
    return {
      computerUse: screen !== undefined && capture,
      stream,
      ...(accessibility ? { accessibility } : {}),
      ...(screen ? { screen } : {}),
    };
  }

  async accessibilityTree(
    query: AccessibilityQuery,
  ): Promise<AccessibilityTree> {
    const atspi = this.#requireAtspi();
    if (query.root) return atspi.tree(query.root, query);
    const id =
      query.window ?? (await this.#xdotool(['getactivewindow'])).trim();
    if (!/^\d+$/.test(id)) throw new Error('No window is focused');
    const [title, pid] = await Promise.all([
      this.#xdotool(['getwindowname', id]).then((name) =>
        name.replace(/\n$/, ''),
      ),
      this.#xdotool(['getwindowpid', id]).then(
        (output) => Number(output.trim()) || undefined,
        () => undefined,
      ),
    ]);
    const handle = await atspi.findWindow({
      title,
      ...(pid ? { pid } : {}),
    });
    if (!handle) {
      throw new Error(
        `Window "${title}" exposes no accessibility tree. ${NO_TREE_HINT}`,
      );
    }
    await atspi.wake(handle);
    return { ...(await atspi.tree(handle, query)), window: title };
  }

  accessibilityElement(
    handle: string,
  ): Promise<AccessibilityElement | undefined> {
    return this.#requireAtspi().element(handle);
  }

  #requireAtspi(): AtspiClient {
    if (!this.#display) {
      throw new Error('No desktop is available');
    }
    return this.#atspi;
  }

  /**
   * The accessibility bus: AT_SPI_BUS_ADDRESS, the AT_SPI_BUS property the
   * bus launcher sets on the root window, or the session bus launcher. The
   * root window works for daemons started outside the desktop session.
   */
  async #atspiAddress(connectBus: AtspiConnector): Promise<string> {
    const fromEnv = this.#env.AT_SPI_BUS_ADDRESS?.trim();
    if (fromEnv) return fromEnv;
    const property = await this.#exec('xprop', ['-root', 'AT_SPI_BUS']).catch(
      () => '',
    );
    const fromRoot = /=\s*"([^"]+)"/.exec(property)?.[1];
    if (fromRoot) return fromRoot;
    const session = this.#env.DBUS_SESSION_BUS_ADDRESS?.trim();
    if (!session) throw new Error('No accessibility bus was found');
    const bus = await connectBus(session);
    try {
      const [address] = await withTimeout(
        bus.call('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress'),
        'The accessibility bus launcher did not answer',
      );
      if (typeof address !== 'string' || address === '') {
        throw new Error('The accessibility bus launcher returned no address');
      }
      return address;
    } finally {
      bus.close();
    }
  }

  async screenSize(): Promise<ScreenSize> {
    const geometry = await this.#xdotool(['getdisplaygeometry']);
    const [width, height] = geometry.trim().split(/\s+/).map(Number);
    if (!width || !height) {
      throw new Error(`Unexpected display geometry: ${geometry.trim()}`);
    }
    return { width, height };
  }

  async openStream(): Promise<Duplex> {
    if (!this.#display) throw new Error('No X display is configured');
    return this.#connectStream();
  }

  #connectStream(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.#connect(this.#vncSocketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('VNC socket connect timed out'));
      }, STREAM_CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(socket);
      });
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once('error', onError);
    });
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    const args = ['-silent', '-window', 'root'];
    if (options.region) {
      const { x, y, width, height } = options.region;
      args.push('-crop', `${width}x${height}+${x}+${y}`, '+repage');
    }
    if (options.size) {
      args.push('-resize', `${options.size.width}x${options.size.height}!`);
    }
    if (options.format === 'jpeg') {
      args.push('-quality', String(JPEG_QUALITY), 'jpeg:-');
    } else {
      args.push('png:-');
    }
    const image = await this.#run('import', args, {
      env: this.#env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_CAPTURE_BYTES,
    });
    if (image.length === 0) throw new Error('Screen capture returned no data');
    return image;
  }

  async click(
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void> {
    const held = modifiers.map(toXdotoolModifier);
    const clickArgs = [
      ...moveArgs(point),
      'click',
      '--repeat',
      String(count),
      '--delay',
      '80',
      BUTTONS[button],
    ];
    if (held.length === 0) {
      await this.#xdotool(clickArgs);
      return;
    }
    try {
      await this.#xdotool(held.flatMap((modifier) => ['keydown', modifier]));
      await this.#xdotool(clickArgs);
    } finally {
      // Release separately so a failed or timed-out click cannot leave keys held.
      await this.#xdotool(
        held.toReversed().flatMap((modifier) => ['keyup', modifier]),
      ).catch(() => undefined);
    }
  }

  async drag(from: Point, to: Point, button: MouseButton): Promise<void> {
    const middle = {
      x: Math.round((from.x + to.x) / 2),
      y: Math.round((from.y + to.y) / 2),
    };
    await this.#xdotool([
      ...moveArgs(from),
      'mousedown',
      BUTTONS[button],
      'sleep',
      '0.05',
      ...moveArgs(middle),
      'sleep',
      '0.05',
      ...moveArgs(to),
      'sleep',
      '0.05',
      'mouseup',
      BUTTONS[button],
    ]);
  }

  async move(point: Point): Promise<void> {
    await this.#xdotool(moveArgs(point));
  }

  async scroll(
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    await this.#xdotool([
      ...moveArgs(point),
      'click',
      '--repeat',
      String(amount),
      '--delay',
      '30',
      SCROLL_BUTTONS[direction],
    ]);
  }

  async type(text: string): Promise<void> {
    const characters = [...text];
    for (let i = 0; i < characters.length; i += TYPE_CHUNK_CHARACTERS) {
      await this.#xdotool([
        'type',
        '--clearmodifiers',
        '--delay',
        '12',
        '--',
        characters.slice(i, i + TYPE_CHUNK_CHARACTERS).join(''),
      ]);
    }
  }

  async key(combos: string[]): Promise<void> {
    await this.#xdotool([
      'key',
      '--clearmodifiers',
      '--delay',
      '40',
      '--',
      ...combos.map(toXdotoolCombo),
    ]);
  }

  async listWindows(): Promise<DesktopWindow[]> {
    const [ids, active] = await Promise.all([
      this.#xdotool(['search', '--onlyvisible', '--name', '']).catch(() => ''),
      this.#xdotool(['getactivewindow']).catch(() => ''),
    ]);
    const focused = active.trim();
    const windows: DesktopWindow[] = [];
    for (const id of ids.split('\n').map((line) => line.trim())) {
      if (!/^\d+$/.test(id)) continue;
      if (windows.length >= MAX_WINDOWS) break;
      const [title, geometry] = await Promise.all([
        this.#xdotool(['getwindowname', id]).catch(() => ''),
        this.#xdotool(['getwindowgeometry', '--shell', id]).catch(() => ''),
      ]);
      const bounds = parseGeometry(geometry);
      if (!bounds || bounds.width <= 1 || bounds.height <= 1) continue;
      windows.push({
        id,
        title: title.replace(/\n$/, ''),
        bounds,
        focused: id === focused,
      });
    }
    return windows;
  }

  async focusWindow(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid window id: ${id}`);
    await this.#xdotool(['windowactivate', '--sync', id]).catch(() =>
      this.#xdotool(['windowfocus', '--sync', id]),
    );
  }

  launch(options: LaunchOptions): Promise<{ pid: number }> {
    return this.#launch({ ...options, env: this.#env });
  }

  async #xdotool(args: string[]): Promise<string> {
    return this.#exec('xdotool', args);
  }

  async #exec(file: string, args: string[]): Promise<string> {
    const output = await this.#run(file, args, {
      env: this.#env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return output.toString('utf8');
  }
}

// No --sync: it waits for pointer motion, so moving to the current position
// blocks until the command times out. XTest keeps the move ahead of later input.
function moveArgs(point: Point): string[] {
  return ['mousemove', String(point.x), String(point.y)];
}

function parseGeometry(output: string): DesktopWindow['bounds'] | undefined {
  const values = new Map(
    output
      .split('\n')
      .map((line) => line.split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key, Number(value)]),
  );
  const x = values.get('X');
  const y = values.get('Y');
  const width = values.get('WIDTH');
  const height = values.get('HEIGHT');
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    [x, y, width, height].some((value) => !Number.isFinite(value))
  ) {
    return undefined;
  }
  return { x, y, width, height };
}
