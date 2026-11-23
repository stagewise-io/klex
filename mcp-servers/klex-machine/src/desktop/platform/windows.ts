import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from 'node:child_process';
import { win32 } from 'node:path';
import type { Duplex } from 'node:stream';

import {
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
  WINDOWS_HELPER_READY,
  windowsHelperBootstrap,
} from './windows-helper.js';

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TYPE_CHUNK_CHARACTERS = 200;
const STDERR_LIMIT = 4_096;
const RELEASE_REQUEST = 'release';
const VK_MENU = 0x12;

/** Sends one request to the desktop helper and resolves its payload. */
export type WindowsDesktopHelper = (
  request: string,
  args: readonly string[],
) => Promise<string>;

export type WindowsProcessLauncher = (
  options: LaunchOptions & { env: NodeJS.ProcessEnv },
) => Promise<{ pid: number }>;

export interface WindowsDesktopProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the persistent PowerShell helper, for tests. */
  helper?: WindowsDesktopHelper;
  launch?: WindowsProcessLauncher;
  /** Receives each new hint from `probe()`. Defaults to stderr. */
  warn?: (hint: string) => void;
}

const VIRTUAL_KEYS: Record<string, number> = {
  alt: 0x12,
  option: 0x12,
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  super: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
  win: 0x5b,
  windows: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  esc: 0x1b,
  escape: 0x1b,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  page_up: 0x21,
  pagedown: 0x22,
  page_down: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
  capslock: 0x14,
  caps_lock: 0x14,
  printscreen: 0x2c,
  print: 0x2c,
  pause: 0x13,
  menu: 0x5d,
  apps: 0x5d,
  numlock: 0x90,
  num_lock: 0x90,
};

const CHARACTER_KEYS: Record<string, string> = { plus: '+', minus: '-' };
const MODIFIER_KEYS = new Set([0x10, 0x11, 0x12, 0x5b]);

/**
 * Map a generic combo such as `Ctrl+Shift+T` or `cmd+l` to helper tokens:
 * `v<virtual key>` for named keys, letters and digits, `c<char code>` for
 * other characters, which the helper resolves through the keyboard layout.
 */
export function toWindowsKeyCombo(combo: string): string {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === '')) {
    throw new Error(`Invalid key combo: ${combo}`);
  }
  return parts
    .map((part) => {
      const lower = part.toLowerCase();
      const named = VIRTUAL_KEYS[lower];
      if (named !== undefined) return `v${named}`;
      const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
      if (fn) return `v${0x6f + Number(fn[1])}`;
      const character = CHARACTER_KEYS[lower] ?? part;
      if (character.length === 1) {
        if (/[a-z0-9]/i.test(character)) {
          return `v${character.toUpperCase().charCodeAt(0)}`;
        }
        const code = character.charCodeAt(0);
        if (code > 0x20 && code !== 0x7f) return `c${code}`;
      }
      throw new Error(`Unsupported key name: ${part}`);
    })
    .join('+');
}

export function toWindowsModifier(modifier: string): number {
  const key = VIRTUAL_KEYS[modifier.toLowerCase()];
  if (key === undefined || !MODIFIER_KEYS.has(key)) {
    throw new Error(`Unsupported modifier: ${modifier}`);
  }
  return key;
}

const launchProcess: WindowsProcessLauncher = ({ command, args, cwd, env }) =>
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
 * Windows desktop: screenshots, input and windows through a persistent
 * Windows PowerShell 5.1 process that compiles a small C# helper once
 * (System.Drawing capture, SendInput, EnumWindows). Nothing is installed.
 * Coordinates are physical pixels of the primary monitor.
 *
 * Session 0 (services) and non-interactive window stations have no desktop.
 * The lock screen and the UAC secure desktop belong to Winlogon and cannot be
 * captured or driven; while one is up, the probe reports no desktop.
 * Streaming and accessibility are not implemented yet.
 */
export class WindowsDesktopProvider implements DesktopProvider {
  readonly #env: NodeJS.ProcessEnv;
  readonly #helper: WindowsDesktopHelper;
  readonly #launch: WindowsProcessLauncher;
  readonly #ownHelper: PowerShellDesktopHelper | undefined;
  /** Set once the session can never have a desktop, so probes stop asking. */
  #permanent: DesktopCapabilities | undefined;
  readonly #warn: (hint: string) => void;
  #lastHint: string | undefined;

  constructor(options: WindowsDesktopProviderOptions = {}) {
    this.#env = options.env ?? process.env;
    if (options.helper) {
      this.#helper = options.helper;
    } else {
      const helper = new PowerShellDesktopHelper({ env: this.#env });
      this.#ownHelper = helper;
      this.#helper = (request, args) => helper.request(request, args);
    }
    this.#launch = options.launch ?? launchProcess;
    this.#warn =
      options.warn ??
      ((hint) => process.stderr.write(`klex-machine desktop: ${hint}\n`));
  }

  async probe(): Promise<DesktopCapabilities> {
    const capabilities = this.#permanent ?? (await this.#check());
    if (capabilities.hint && capabilities.hint !== this.#lastHint) {
      this.#warn(capabilities.hint);
    }
    this.#lastHint = capabilities.hint;
    return capabilities;
  }

  async #check(): Promise<DesktopCapabilities> {
    let info: Map<string, string>;
    try {
      info = parseFields(await this.#helper('probe', []));
    } catch (error) {
      return unavailable(
        `The Windows desktop helper did not start: ${message(error)}. It needs Windows PowerShell 5.1 with Add-Type allowed; Constrained Language Mode and some application control policies block it.`,
      );
    }
    const session = info.get('session');
    if (session === '0') {
      return this.#unavailableForever(
        "klex-machine is running in Session 0, where Windows services run, which has no interactive desktop. Run it in the signed-in user's session, for example from a logon task or the Startup folder, to use the desktop.",
      );
    }
    if (info.get('interactive') !== '1') {
      return this.#unavailableForever(
        "klex-machine's window station is not interactive, as in an SSH session or a task set to run whether or not the user is signed in. Run it in the signed-in user's desktop session to use the desktop.",
      );
    }
    const desktop = decode(info.get('desktop') ?? '');
    if (desktop.toLowerCase() !== 'default') {
      return unavailable(
        `The input desktop is ${desktop ? `"${desktop}"` : 'not accessible'}: Windows is locked, or the sign-in screen or a UAC prompt is showing. These secure desktops cannot be captured or driven; computer use returns once the user is back on their desktop.`,
      );
    }
    const width = Number(info.get('width'));
    const height = Number(info.get('height'));
    if (!(width > 0 && height > 0)) {
      return unavailable('Windows reported no primary screen.');
    }
    const capture = info.get('capture');
    if (capture !== 'ok') {
      return unavailable(
        `Screen capture failed: ${decode(capture ?? '')}. A minimized or disconnected Remote Desktop session has no screen to capture.`,
      );
    }
    return { computerUse: true, stream: false, screen: { width, height } };
  }

  #unavailableForever(hint: string): DesktopCapabilities {
    this.#permanent = unavailable(hint);
    this.#ownHelper?.close();
    return this.#permanent;
  }

  async screenSize(): Promise<ScreenSize> {
    const output = await this.#helper('size', []);
    const [width, height] = output.trim().split(/\s+/).map(Number);
    if (!width || !height || width <= 0 || height <= 0) {
      throw new Error(`Unexpected screen size: ${output.trim()}`);
    }
    return { width, height };
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    const region = options.region
      ? [
          options.region.x,
          options.region.y,
          options.region.width,
          options.region.height,
        ].map(integer)
      : ['-', '-', '-', '-'];
    const size = options.size
      ? [options.size.width, options.size.height].map(integer)
      : ['-', '-'];
    const image = Buffer.from(
      await this.#helper('capture', [...region, ...size, options.format]),
      'base64',
    );
    if (image.length === 0) throw new Error('Screen capture returned no data');
    return image;
  }

  async click(
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void> {
    const held = modifiers.map(toWindowsModifier);
    await this.#helper('click', [
      ...coordinates(point),
      button,
      integer(count),
      held.length > 0 ? held.join(',') : '-',
    ]);
  }

  async drag(from: Point, to: Point, button: MouseButton): Promise<void> {
    await this.#helper('drag', [
      ...coordinates(from),
      ...coordinates(to),
      button,
    ]);
  }

  async move(point: Point): Promise<void> {
    await this.#helper('move', coordinates(point));
  }

  async scroll(
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    await this.#helper('scroll', [
      ...coordinates(point),
      direction,
      integer(amount),
    ]);
  }

  async type(text: string): Promise<void> {
    const characters = [...text];
    for (let i = 0; i < characters.length; i += TYPE_CHUNK_CHARACTERS) {
      const chunk = characters.slice(i, i + TYPE_CHUNK_CHARACTERS).join('');
      await this.#helper('type', [Buffer.from(chunk).toString('base64')]);
    }
  }

  async key(combos: string[]): Promise<void> {
    if (combos.length === 0) return;
    await this.#helper('key', combos.map(toWindowsKeyCombo));
  }

  async listWindows(): Promise<DesktopWindow[]> {
    const output = await this.#helper('windows', []);
    const windows: DesktopWindow[] = [];
    for (const record of output.split(';')) {
      const [id, x, y, width, height, focused, title] = record.split(',');
      if (!id || !/^\d+$/.test(id) || title === undefined) continue;
      const bounds = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
      if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
        continue;
      }
      windows.push({
        id,
        title: decode(title),
        bounds,
        focused: focused === '1',
      });
    }
    return windows;
  }

  async focusWindow(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid window id: ${id}`);
    await this.#helper('focus', [id]);
  }

  launch(options: LaunchOptions): Promise<{ pid: number }> {
    return this.#launch({ ...options, env: this.#env });
  }

  async openStream(): Promise<Duplex> {
    throw new Error('Desktop streaming is not available on Windows yet');
  }

  /** Stops the helper process; the next call starts a new one. */
  close(): void {
    this.#ownHelper?.close();
  }
}

function unavailable(hint: string): DesktopCapabilities {
  return { ...NO_DESKTOP, hint };
}

function parseFields(output: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of output.split('\t')) {
    const separator = field.indexOf('=');
    if (separator > 0) {
      fields.set(field.slice(0, separator), field.slice(separator + 1));
    }
  }
  return fields;
}

function integer(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Invalid number: ${value}`);
  return String(Math.round(value));
}

function coordinates(point: Point): string[] {
  return [integer(point.x), integer(point.y)];
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /\.$/,
    '',
  );
}

export type HelperSpawner = (
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface PowerShellDesktopHelperOptions {
  env?: NodeJS.ProcessEnv;
  spawn?: HelperSpawner;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * One long-lived `powershell.exe` running the C# helper. Requests are
 * serialized; a timeout, crash or protocol error kills the process and the
 * next request starts a fresh one. While idle it never keeps Node alive.
 *
 * A helper lost mid-request never ran its cleanup, so before anything else
 * runs, a fresh helper lets go of the keys and buttons that request held.
 */
export class PowerShellDesktopHelper {
  readonly #env: NodeJS.ProcessEnv;
  readonly #spawn: HelperSpawner;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #connection: HelperConnection | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;

  constructor(options: PowerShellDesktopHelperOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#spawn =
      options.spawn ??
      ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  request(request: string, args: readonly string[]): Promise<string> {
    const generation = this.#generation;
    const result = this.#queue.then(() => this.#run(generation, request, args));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Stops the helper and fails queued requests; later requests start anew. */
  close(): void {
    this.#generation += 1;
    this.#connection?.kill();
    this.#connection = undefined;
  }

  async #run(
    generation: number,
    request: string,
    args: readonly string[],
  ): Promise<string> {
    try {
      return await this.#exchange(generation, request, args);
    } catch (error) {
      const release =
        error instanceof HelperLostError
          ? releaseArgs(request, args)
          : undefined;
      if (release) {
        await this.#exchange(generation, RELEASE_REQUEST, release).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async #exchange(
    generation: number,
    request: string,
    args: readonly string[],
  ): Promise<string> {
    if (generation !== this.#generation) {
      throw new Error('The desktop helper was stopped');
    }
    for (const value of [request, ...args]) {
      if (/[\t\r\n]/.test(value)) {
        throw new Error(
          'Desktop helper arguments cannot contain tabs or newlines',
        );
      }
    }
    const connection = await this.#connect();
    try {
      connection.write([request, ...args].join('\t'));
      const line = await connection.nextLine(this.#requestTimeoutMs);
      const separator = line.indexOf('\t');
      const status = separator === -1 ? line : line.slice(0, separator);
      const payload = separator === -1 ? '' : line.slice(separator + 1);
      if (status === 'ok') return payload;
      if (status === 'err')
        throw new Error(decode(payload) || 'Desktop helper failed');
      connection.kill();
      throw new Error(
        `Unexpected desktop helper output: ${line.slice(0, 200)}`,
      );
    } catch (error) {
      if (connection.closed) {
        throw new HelperLostError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      connection.unref();
    }
  }

  async #connect(): Promise<HelperConnection> {
    if (this.#connection && !this.#connection.closed) {
      this.#connection.ref();
      return this.#connection;
    }
    const system32 = win32.join(
      this.#env.SystemRoot ?? this.#env.SYSTEMROOT ?? 'C:\\Windows',
      'System32',
    );
    const connection = new HelperConnection(
      this.#spawn(
        win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
        // Not the daemon's cwd: an orphaned helper would keep it locked.
        { cwd: system32, env: this.#env, windowsHide: true },
      ),
    );
    this.#connection = connection;
    const deadline = Date.now() + this.#startupTimeoutMs;
    try {
      connection.write(windowsHelperBootstrap());
      // PowerShell may print banners or prompts before the helper takes over.
      let line = '';
      while (!line.endsWith(WINDOWS_HELPER_READY)) {
        line = await connection.nextLine(deadline - Date.now());
      }
    } catch (error) {
      connection.kill();
      connection.unref();
      throw error;
    }
    return connection;
  }
}

/** The helper died or was killed while a request was in flight. */
class HelperLostError extends Error {}

/**
 * What a lost request may have left pressed, as `release` arguments: key
 * tokens and mouse buttons. Clicks hold modifiers, drags a button, key combos
 * their keys and focus Alt; other requests send atomic down-up pairs.
 */
function releaseArgs(
  request: string,
  args: readonly string[],
): string[] | undefined {
  switch (request) {
    case 'click': {
      const modifiers = args[4] ?? '-';
      return [
        modifiers === '-'
          ? '-'
          : modifiers
              .split(',')
              .map((key) => `v${key}`)
              .join('+'),
        args[2] ?? '-',
      ];
    }
    case 'drag':
      return ['-', args[4] ?? '-'];
    case 'key':
      return args.length > 0 ? [args.join('+'), '-'] : undefined;
    case 'focus':
      return [`v${VK_MENU}`, '-'];
    default:
      return undefined;
  }
}

class HelperConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  #partial: string[] = [];
  #lines: string[] = [];
  #waiter:
    | { resolve: (line: string) => void; reject: (error: Error) => void }
    | undefined;
  #stderr = '';
  #error: Error | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => this.#fail(error));
    child.once('close', (code, signal) => {
      const detail = this.#stderr.trim().split('\n').at(-1)?.trim();
      this.#fail(
        new Error(
          `PowerShell exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  }

  get closed(): boolean {
    return this.#error !== undefined;
  }

  write(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  nextLine(timeoutMs: number): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#waiter = undefined;
          this.kill();
          reject(
            new Error(
              `The desktop helper did not answer within ${timeoutMs} ms`,
            ),
          );
        },
        Math.max(timeoutMs, 0),
      );
      this.#waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  ref(): void {
    this.#setRef(true);
  }

  unref(): void {
    this.#setRef(false);
  }

  kill(): void {
    if (!this.#error) this.#fail(new Error('The desktop helper was stopped'));
    this.#child.kill();
  }

  #setRef(on: boolean): void {
    const child = this.#child;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
      const refable = handle as { ref?: () => void; unref?: () => void };
      if (on) refable.ref?.();
      else refable.unref?.();
    }
  }

  #read(chunk: string): void {
    let start = 0;
    for (
      let end = chunk.indexOf('\n');
      end !== -1;
      end = chunk.indexOf('\n', start)
    ) {
      this.#partial.push(chunk.slice(start, end));
      const line = this.#partial.join('').replace(/\r$/, '');
      this.#partial = [];
      start = end + 1;
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter) waiter.resolve(line);
      else this.#lines.push(line);
    }
    if (start < chunk.length) this.#partial.push(chunk.slice(start));
  }

  #fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(error);
  }
}
