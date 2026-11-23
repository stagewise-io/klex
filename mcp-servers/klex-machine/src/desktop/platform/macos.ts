import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  type CaptureOptions,
  type DesktopCapabilities,
  type DesktopProvider,
  type DesktopWindow,
  type LaunchOptions,
  type MouseButton,
  NO_DESKTOP,
  type Point,
  type Region,
  type ScreenSize,
  type ScrollDirection,
} from '../provider.js';

export const MACOS_HELPER_NAME = 'klex-desktop-helper';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const SIPS = '/usr/bin/sips';
const COMMAND_TIMEOUT_MS = 15_000;
// Longer than the helper's own 30 second wait for Launch Services, so a slow
// cold start reports the helper's error instead of being killed mid-launch.
const LAUNCH_TIMEOUT_MS = 45_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_WINDOWS = 50;
const TYPE_CHUNK_CHARACTERS = 200;
const JPEG_QUALITY = 75;
// Input re-reads the scale only when the last read is older than this; the
// service reads the screen size before every action anyway.
const DISPLAY_TTL_MS = 2_000;

const SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export const MISSING_HELPER_HINT = `The macOS desktop helper (${MACOS_HELPER_NAME}) is missing from this klex-machine install. Reinstall @klex/machine to get it.`;
export const NO_SESSION_HINT =
  'No logged-in macOS desktop session is available to klex-machine. Start it from a Terminal in the logged-in user session, not over SSH or as a system daemon.';

export type MacosCommandRunner = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
    /** Written to stdin, which is closed afterwards. */
    input?: string;
  },
) => Promise<Buffer>;

export type MacosProcessLauncher = (
  options: LaunchOptions & { env: NodeJS.ProcessEnv },
) => Promise<{ pid: number }>;

export interface MacosDesktopProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** The helper binary. Found next to the bundle, or in dist/ from sources, when omitted. */
  helperPath?: string;
  run?: MacosCommandRunner;
  launch?: MacosProcessLauncher;
  /** Receives each new hint from `probe()`. Defaults to stderr. */
  warn?: (hint: string) => void;
  now?: () => number;
}

interface MacosDisplay {
  /** Points. */
  width: number;
  height: number;
  /** Pixels of the backing store, which is what `screencapture` returns. */
  pixelWidth: number;
  pixelHeight: number;
}

interface MacosProbe extends MacosDisplay {
  session: boolean;
  screenRecording: boolean;
  accessibility: boolean;
}

interface HelperWindow {
  id: string;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
}

const MODIFIERS: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  fn: 'fn',
};

const MODIFIER_KEY_CODES: Record<string, number> = {
  cmd: 55,
  shift: 56,
  alt: 58,
  ctrl: 59,
  fn: 63,
};

// Virtual key codes from Carbon's Events.h (kVK_*).
const NAMED_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  esc: 53,
  escape: 53,
  capslock: 57,
  insert: 114,
  help: 114,
  home: 115,
  pageup: 116,
  page_up: 116,
  delete: 117,
  del: 117,
  end: 119,
  pagedown: 121,
  page_down: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
};

/** F1 to F20. */
const FUNCTION_KEY_CODES = [
  122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106,
  64, 79, 80, 90,
];

const CHARACTER_NAMES: Record<string, string> = { plus: '+', minus: '-' };

const TERMINAL_APPS: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  WarpTerminal: 'Warp',
  ghostty: 'Ghostty',
  vscode: 'your editor (Visual Studio Code or Cursor)',
};

export function toMacosModifier(modifier: string): string {
  const mapped = MODIFIERS[modifier.toLowerCase()];
  if (!mapped) throw new Error(`Unsupported modifier: ${modifier}`);
  return mapped;
}

function toMacosKey(part: string): string {
  const lower = part.toLowerCase();
  const modifier = MODIFIERS[lower];
  if (modifier) return `code:${MODIFIER_KEY_CODES[modifier]}`;
  const named = NAMED_KEY_CODES[lower];
  if (named !== undefined) return `code:${named}`;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(part);
  if (functionKey) {
    const code = FUNCTION_KEY_CODES[Number(functionKey[1]) - 1];
    if (code === undefined) {
      throw new Error(`macOS has no ${part.toUpperCase()} key; F1 to F20 work`);
    }
    return `code:${code}`;
  }
  const character = CHARACTER_NAMES[lower] ?? part;
  if (/^[\x21-\x7e]$/.test(character)) return `char:${character.toLowerCase()}`;
  throw new Error(`Unsupported key name: ${part}`);
}

/**
 * Map a generic combo such as `Cmd+Shift+T` or `ctrl+a` to the helper's chord
 * argument, `<modifiers>|code:<key code>` or `<modifiers>|char:<character>`.
 * Characters are resolved against the current keyboard layout by the helper.
 */
export function toMacosChord(combo: string): string {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    throw new Error(`Invalid key combo: ${combo}`);
  }
  const key = toMacosKey(parts.at(-1) ?? '');
  const held = [...new Set(parts.slice(0, -1).map(toMacosModifier))];
  return `${held.join(',')}|${key}`;
}

export function macosPermissionHint(
  missing: readonly ('Screen Recording' | 'Accessibility')[],
  env: NodeJS.ProcessEnv,
): string {
  const terminal = TERMINAL_APPS[env.TERM_PROGRAM ?? ''];
  const app =
    terminal ??
    'the app that starts klex-machine (your terminal, or node when it runs as a background service)';
  const panes = missing.map((name) =>
    name === 'Screen Recording'
      ? 'Screen & System Audio Recording (Screen Recording before macOS 15)'
      : 'Accessibility',
  );
  const links = missing.map(
    (name) =>
      `open "${name === 'Screen Recording' ? SCREEN_RECORDING_SETTINGS : ACCESSIBILITY_SETTINGS}"`,
  );
  return `Computer use on macOS needs ${missing.join(' and ')} permission. In System Settings > Privacy & Security, turn on ${app} under ${panes.join(' and under ')}, then quit and reopen ${terminal ?? 'that app'} and restart klex-machine. To open the settings, run: ${links.join(' && ')}`;
}

const runCommand: MacosCommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: 'buffer',
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
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });

const launchProcess: MacosProcessLauncher = ({ command, args, cwd, env }) =>
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

function defaultHelperCandidates(): string[] {
  const here = import.meta.url;
  // Bundled, this module is dist/index.js and the helper sits in dist/macos.
  const candidates = [
    fileURLToPath(new URL(`./macos/${MACOS_HELPER_NAME}`, here)),
  ];
  if (here.endsWith('.ts')) {
    candidates.push(
      fileURLToPath(new URL(`../../../dist/macos/${MACOS_HELPER_NAME}`, here)),
    );
  }
  return candidates;
}

/**
 * macOS desktop: capture through the built-in `screencapture` and `sips`, and
 * input, windows and app launch through a small Swift helper using CGEvent,
 * CGWindowList and NSWorkspace. Computer use needs a logged-in window server
 * session plus Screen Recording and Accessibility permission for the app that
 * started klex-machine. There is no stream and no accessibility tree yet.
 *
 * The provider works in physical pixels; the helper takes and returns points,
 * so coordinates are scaled by the backing scale factor (2 on Retina).
 */
export class MacosDesktopProvider implements DesktopProvider {
  readonly #env: NodeJS.ProcessEnv;
  readonly #helperCandidates: string[];
  readonly #run: MacosCommandRunner;
  readonly #launch: MacosProcessLauncher;
  readonly #warn: (hint: string) => void;
  readonly #now: () => number;
  #helper: string | undefined;
  #display: { value: MacosDisplay; at: number } | undefined;
  #lastHint: string | undefined;

  constructor(options: MacosDesktopProviderOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#helperCandidates = options.helperPath
      ? [options.helperPath]
      : defaultHelperCandidates();
    this.#run = options.run ?? runCommand;
    this.#launch = options.launch ?? launchProcess;
    this.#warn =
      options.warn ??
      ((hint) => process.stderr.write(`klex-machine desktop: ${hint}\n`));
    this.#now = options.now ?? Date.now;
  }

  async probe(): Promise<DesktopCapabilities> {
    let capabilities: DesktopCapabilities;
    try {
      capabilities = await this.#check();
    } catch (error) {
      capabilities = unavailable(
        `The macOS desktop helper failed: ${errorMessage(error)}`,
      );
    }
    if (capabilities.hint && capabilities.hint !== this.#lastHint) {
      this.#warn(capabilities.hint);
    }
    this.#lastHint = capabilities.hint;
    return capabilities;
  }

  async #check(): Promise<DesktopCapabilities> {
    const helper = await this.#findHelper();
    if (!helper) return unavailable(MISSING_HELPER_HINT);
    const probe = parseProbe(await this.#exec(helper, ['probe']));
    if (!probe.session) return unavailable(NO_SESSION_HINT);
    const missing = [
      ...(probe.screenRecording ? [] : (['Screen Recording'] as const)),
      ...(probe.accessibility ? [] : (['Accessibility'] as const)),
    ];
    if (missing.length > 0) {
      return unavailable(macosPermissionHint(missing, this.#env));
    }
    this.#display = { value: probe, at: this.#now() };
    return {
      computerUse: true,
      stream: false,
      screen: { width: probe.pixelWidth, height: probe.pixelHeight },
    };
  }

  async screenSize(): Promise<ScreenSize> {
    const display = await this.#readDisplay();
    return { width: display.pixelWidth, height: display.pixelHeight };
  }

  openStream(): Promise<Duplex> {
    return Promise.reject(
      new Error('Streaming the macOS desktop is not supported yet'),
    );
  }

  async capture(options: CaptureOptions): Promise<Buffer> {
    const display = await this.#currentDisplay();
    const work = await mkdtemp(join(tmpdir(), 'klex-machine-capture-'));
    try {
      const shot = join(work, 'screen.png');
      const args = ['-x', '-t', 'png'];
      if (options.region) {
        const { x, y, width, height } = toPointRegion(options.region, display);
        args.push('-R', `${x},${y},${width},${height}`);
      } else {
        args.push('-m');
      }
      args.push(shot);
      await this.#exec(SCREENCAPTURE, args);
      let output = shot;
      if (options.size || options.format === 'jpeg') {
        output = join(work, `screen-out.${options.format}`);
        await this.#exec(SIPS, [
          ...(options.size
            ? ['-z', String(options.size.height), String(options.size.width)]
            : []),
          '-s',
          'format',
          options.format,
          ...(options.format === 'jpeg'
            ? ['-s', 'formatOptions', String(JPEG_QUALITY)]
            : []),
          shot,
          '--out',
          output,
        ]);
      }
      const image = await readFile(output);
      if (image.length === 0)
        throw new Error('Screen capture returned no data');
      return image;
    } finally {
      await rm(work, { force: true, recursive: true });
    }
  }

  async click(
    point: Point,
    button: MouseButton,
    count: number,
    modifiers: string[],
  ): Promise<void> {
    const held = [...new Set(modifiers.map(toMacosModifier))];
    const [x, y] = await this.#toPoints(point);
    await this.#helperRun([
      'click',
      x,
      y,
      button,
      String(count),
      held.join(','),
    ]);
  }

  async drag(from: Point, to: Point, button: MouseButton): Promise<void> {
    const [fromX, fromY] = await this.#toPoints(from);
    const [toX, toY] = await this.#toPoints(to);
    await this.#helperRun(['drag', fromX, fromY, toX, toY, button]);
  }

  async move(point: Point): Promise<void> {
    await this.#helperRun(['move', ...(await this.#toPoints(point))]);
  }

  async scroll(
    point: Point,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    await this.#helperRun([
      'scroll',
      ...(await this.#toPoints(point)),
      direction,
      String(amount),
    ]);
  }

  async type(text: string): Promise<void> {
    const characters = [...text];
    for (let i = 0; i < characters.length; i += TYPE_CHUNK_CHARACTERS) {
      await this.#helperRun(
        ['type'],
        characters.slice(i, i + TYPE_CHUNK_CHARACTERS).join(''),
      );
    }
  }

  async key(combos: string[]): Promise<void> {
    await this.#helperRun(['key', ...combos.map(toMacosChord)]);
  }

  async listWindows(): Promise<DesktopWindow[]> {
    const display = await this.#currentDisplay();
    const listed = parseWindows(await this.#helperRun(['windows']));
    const windows: DesktopWindow[] = [];
    for (const window of listed) {
      if (windows.length >= MAX_WINDOWS) break;
      const bounds = toPixelRegion(window, display);
      if (bounds.width <= 1 || bounds.height <= 1) continue;
      windows.push({
        id: window.id,
        title: window.title
          ? window.app
            ? `${window.title} - ${window.app}`
            : window.title
          : window.app,
        bounds,
        focused: window.focused,
      });
    }
    return windows;
  }

  async focusWindow(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid window id: ${id}`);
    await this.#helperRun(['focus', id]);
  }

  /**
   * App bundles such as `Safari.app` or `/Applications/Safari.app` open
   * through Launch Services; anything else is spawned as a process.
   */
  async launch(options: LaunchOptions): Promise<{ pid: number }> {
    if (!/\.app\/?$/i.test(options.command)) {
      return this.#launch({ ...options, env: this.#env });
    }
    const output = await this.#exec(
      await this.#requireHelper(),
      ['launch-app', options.command.replace(/\/$/, ''), ...options.args],
      { timeoutMs: LAUNCH_TIMEOUT_MS },
    );
    const { pid } = JSON.parse(output) as { pid?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`${options.command} opened without a process id`);
    }
    return { pid };
  }

  async #findHelper(): Promise<string | undefined> {
    if (this.#helper) return this.#helper;
    for (const candidate of this.#helperCandidates) {
      try {
        await access(candidate, constants.X_OK);
        this.#helper = candidate;
        return candidate;
      } catch {}
    }
    return undefined;
  }

  async #requireHelper(): Promise<string> {
    const helper = await this.#findHelper();
    if (!helper) throw new Error(MISSING_HELPER_HINT);
    return helper;
  }

  async #readDisplay(): Promise<MacosDisplay> {
    const display = parseDisplay(
      await this.#exec(await this.#requireHelper(), ['display']),
    );
    this.#display = { value: display, at: this.#now() };
    return display;
  }

  async #currentDisplay(): Promise<MacosDisplay> {
    if (this.#display && this.#now() - this.#display.at < DISPLAY_TTL_MS) {
      return this.#display.value;
    }
    return this.#readDisplay();
  }

  async #toPoints(point: Point): Promise<[string, string]> {
    const display = await this.#currentDisplay();
    return [
      formatPoint((point.x * display.width) / display.pixelWidth),
      formatPoint((point.y * display.height) / display.pixelHeight),
    ];
  }

  async #helperRun(args: string[], input?: string): Promise<string> {
    return this.#exec(
      await this.#requireHelper(),
      args,
      input !== undefined ? { input } : {},
    );
  }

  async #exec(
    file: string,
    args: string[],
    options: { input?: string; timeoutMs?: number } = {},
  ): Promise<string> {
    const output = await this.#run(file, args, {
      env: this.#env,
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: file === SCREENCAPTURE ? MAX_CAPTURE_BYTES : 1024 * 1024,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return output.toString('utf8');
  }
}

function unavailable(hint: string): DesktopCapabilities {
  return { ...NO_DESKTOP, hint };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPoint(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** A pixel region as the smallest whole-point region that covers it. */
function toPointRegion(region: Region, display: MacosDisplay): Region {
  const scaleX = display.pixelWidth / display.width;
  const scaleY = display.pixelHeight / display.height;
  const x = Math.floor(region.x / scaleX);
  const y = Math.floor(region.y / scaleY);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil((region.x + region.width) / scaleX) - x),
    height: Math.max(1, Math.ceil((region.y + region.height) / scaleY) - y),
  };
}

function toPixelRegion(region: Region, display: MacosDisplay): Region {
  const scaleX = display.pixelWidth / display.width;
  const scaleY = display.pixelHeight / display.height;
  return {
    x: Math.round(region.x * scaleX),
    y: Math.round(region.y * scaleY),
    width: Math.round(region.width * scaleX),
    height: Math.round(region.height * scaleY),
  };
}

function parseJson(output: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`The macOS desktop helper returned invalid ${what}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The macOS desktop helper returned invalid ${what}`);
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseDisplay(output: string): MacosDisplay {
  const value = parseJson(output, 'display geometry');
  const { width, height, pixelWidth, pixelHeight } = value;
  if (
    !positive(width) ||
    !positive(height) ||
    !positive(pixelWidth) ||
    !positive(pixelHeight)
  ) {
    throw new Error(`Unexpected display geometry: ${output.trim()}`);
  }
  return { width, height, pixelWidth, pixelHeight };
}

function parseProbe(output: string): MacosProbe {
  const value = parseJson(output, 'probe');
  const session = value.session === true;
  const flags = {
    session,
    screenRecording: value.screenRecording === true,
    accessibility: value.accessibility === true,
  };
  // Without a window server session the display geometry is meaningless.
  if (!session) {
    return { ...flags, width: 0, height: 0, pixelWidth: 0, pixelHeight: 0 };
  }
  return { ...flags, ...parseDisplay(output) };
}

function parseWindows(output: string): HelperWindow[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('The macOS desktop helper returned an invalid window list');
  }
  if (!Array.isArray(value)) {
    throw new Error('The macOS desktop helper returned an invalid window list');
  }
  return value.flatMap((entry): HelperWindow[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, app, title, x, y, width, height, focused } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof id !== 'string' ||
      !/^\d+$/.test(id) ||
      ![x, y, width, height].every(
        (n) => typeof n === 'number' && Number.isFinite(n),
      )
    ) {
      return [];
    }
    return [
      {
        id,
        app: typeof app === 'string' ? app : '',
        title: typeof title === 'string' ? title : '',
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number,
        focused: focused === true,
      },
    ];
  });
}
