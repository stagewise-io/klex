import dbus from 'dbus-next';

import type {
  AccessibilityElement,
  AccessibilityNode,
  AccessibilityTree,
  Region,
} from '../provider.js';

const REGISTRY = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const NULL_PATH = '/org/a11y/atspi/null';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const COMPONENT = 'org.a11y.atspi.Component';
const TEXT = 'org.a11y.atspi.Text';
const VALUE = 'org.a11y.atspi.Value';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const DBUS = 'org.freedesktop.DBus';
const COORD_SCREEN = 0;

const CALL_TIMEOUT_MS = 2_000;
const WALK_DEADLINE_MS = 4_000;
const MAX_VISITED = 5_000;
const MAX_CHILDREN = 200;
const CONCURRENCY = 16;
const MAX_VALUE_CHARACTERS = 200;
const WAKE_ATTEMPTS = 10;
const WAKE_INTERVAL_MS = 100;

/** One D-Bus connection to the accessibility bus. */
export interface AtspiBus {
  call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
  ): Promise<unknown[]>;
  /** True once the transport failed; the client then reconnects. */
  readonly closed: boolean;
  close(): void;
}

export type AtspiConnector = (address: string) => Promise<AtspiBus>;

/** AtspiStateType bit positions, from at-spi2-core's atspi-constants.h. */
const STATE = {
  active: 1,
  checked: 4,
  collapsed: 5,
  defunct: 6,
  editable: 7,
  enabled: 8,
  expandable: 9,
  expanded: 10,
  focusable: 11,
  focused: 12,
  modal: 16,
  pressed: 20,
  selected: 23,
  sensitive: 24,
  showing: 25,
  visible: 30,
  indeterminate: 32,
  required: 33,
  checkable: 41,
  readOnly: 43,
} as const;

const INTERACTIVE_ROLES = new Set([
  'check box',
  'check menu item',
  'combo box',
  'entry',
  'icon',
  'link',
  'list item',
  'menu',
  'menu item',
  'page tab',
  'password text',
  'push button',
  'radio button',
  'radio menu item',
  'slider',
  'spin button',
  'switch',
  'table cell',
  'toggle button',
  'tree item',
]);

/** Unnamed nodes with these roles only group others and are left out. */
const WRAPPER_ROLES = new Set([
  'filler',
  'grouping',
  'invalid',
  'layered pane',
  'panel',
  'redundant object',
  'scroll pane',
  'section',
  'split pane',
  'unknown',
  'viewport',
]);

const VALUE_ROLES = new Set([
  'progress bar',
  'scroll bar',
  'slider',
  'spin button',
]);

export interface AtspiWalkOptions {
  interactiveOnly: boolean;
  maxDepth: number;
  maxNodes: number;
}

interface RawNode {
  bus: string;
  path: string;
  role: string;
  name: string;
  states: Set<number>;
  children: [string, string][];
}

/**
 * A pure-JS AT-SPI2 client: application lookup, a bounded tree walk and live
 * re-reads of single elements. Handles are `bus|path` and stay valid while the
 * element lives.
 */
export class AtspiClient {
  readonly #address: () => Promise<string>;
  readonly #connect: AtspiConnector;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #bus: Promise<AtspiBus> | undefined;

  constructor(options: {
    address: () => Promise<string>;
    connect?: AtspiConnector;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.#address = options.address;
    this.#connect = options.connect ?? connectAtspiBus;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** True when the registry answers. Never rejects. */
  async available(): Promise<boolean> {
    try {
      await this.#applications();
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    const bus = this.#bus;
    this.#bus = undefined;
    void bus?.then((connection) => connection.close()).catch(() => undefined);
  }

  /**
   * The top-level frame of a window, matched by owning process first and by
   * title second, or undefined when no application exposes it.
   */
  async findWindow(target: {
    pid?: number;
    title: string;
  }): Promise<string | undefined> {
    const apps = await this.#applications();
    const owned: [string, string][] = [];
    if (target.pid !== undefined) {
      await Promise.all(
        apps.map(async (app) => {
          const pid = await this.#call(
            DBUS,
            '/org/freedesktop/DBus',
            DBUS,
            'GetConnectionUnixProcessID',
            's',
            [app[0]],
          ).catch(() => undefined);
          if (pid?.[0] === target.pid) owned.push(app);
        }),
      );
    }
    for (const candidates of [owned, apps]) {
      const frames: { handle: string; name: string; active: boolean }[] = [];
      for (const [bus, path] of candidates) {
        const children = await this.#children(bus, path).catch(() => []);
        for (const [childBus, childPath] of children) {
          const [name, states] = await Promise.all([
            this.#name(childBus, childPath).catch(() => ''),
            this.#states(childBus, childPath).catch(() => new Set<number>()),
          ]);
          frames.push({
            handle: encodeHandle(childBus, childPath),
            name,
            active: states.has(STATE.active),
          });
        }
      }
      const match =
        frames.find((frame) => frame.name === target.title) ??
        (candidates === owned
          ? (frames.find((frame) => frame.active) ??
            (frames.length === 1 ? frames[0] : undefined))
          : undefined);
      if (match) return match.handle;
    }
    return undefined;
  }

  /**
   * Chromium and Electron build their tree only after a client reads
   * attributes, as Orca does. Waits briefly for children to appear.
   */
  async wake(handle: string): Promise<void> {
    const [bus, path] = decodeHandle(handle);
    await this.#call(bus, path, ACCESSIBLE, 'GetAttributes').catch(
      () => undefined,
    );
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt += 1) {
      const count = await this.#property(bus, path, ACCESSIBLE, 'ChildCount')
        .then(Number)
        .catch(() => 0);
      if (count > 0) return;
      await this.#sleep(WAKE_INTERVAL_MS);
    }
  }

  /** Pre-order, pruned walk of `handle`'s subtree. */
  async tree(
    handle: string,
    options: AtspiWalkOptions,
  ): Promise<Omit<AccessibilityTree, 'window'>> {
    const deadline = this.#now() + WALK_DEADLINE_MS;
    const nodes: AccessibilityNode[] = [];
    let visited = 0;
    let kept = 0;
    let truncated = false;
    let running = 0;
    const waiting: (() => void)[] = [];
    const limited = async <T>(task: () => Promise<T>): Promise<T> => {
      if (running >= CONCURRENCY)
        await new Promise<void>((resolve) => waiting.push(resolve));
      running += 1;
      try {
        return await task();
      } finally {
        running -= 1;
        waiting.shift()?.();
      }
    };

    // Each node's output is collected in place so siblings fetched in
    // parallel still print in document order.
    type Out = { node?: AccessibilityNode; children: Out[] };
    const visit = async (
      bus: string,
      path: string,
      depth: number,
      printedDepth: number,
      root: boolean,
    ): Promise<Out | undefined> => {
      // Parallel siblings mean a stopped walk may skip nodes before the last
      // kept one; the result is then marked truncated.
      if (
        visited >= MAX_VISITED ||
        kept >= options.maxNodes ||
        this.#now() > deadline
      ) {
        truncated = true;
        return undefined;
      }
      visited += 1;
      const raw = await limited(() => this.#raw(bus, path)).catch(
        () => undefined,
      );
      if (!raw || raw.states.has(STATE.defunct)) return undefined;
      if (!root && !raw.states.has(STATE.showing)) return undefined;
      const keep =
        root ||
        (options.interactiveOnly
          ? isInteractive(raw)
          : raw.name.trim() !== '' ||
            isInteractive(raw) ||
            !WRAPPER_ROLES.has(raw.role));
      const out: Out = { children: [] };
      if (keep) {
        const element = await limited(() => this.#element(raw)).catch(
          () => undefined,
        );
        if (element) {
          out.node = { ...element, depth: printedDepth };
          kept += 1;
        }
      }
      if (depth >= options.maxDepth) {
        if (raw.children.length > 0) truncated = true;
        return out;
      }
      if (raw.children.length > MAX_CHILDREN) truncated = true;
      const nextPrinted = out.node ? printedDepth + 1 : printedDepth;
      out.children = (
        await Promise.all(
          raw.children
            .slice(0, MAX_CHILDREN)
            .map(([childBus, childPath]) =>
              visit(childBus, childPath, depth + 1, nextPrinted, false),
            ),
        )
      ).filter((child): child is Out => child !== undefined);
      return out;
    };

    const [bus, path] = decodeHandle(handle);
    const result = await visit(bus, path, 0, 0, true);
    if (!result?.node) throw new Error('The accessibility element is gone');
    const flatten = (out: Out) => {
      if (out.node) {
        if (nodes.length >= options.maxNodes) {
          truncated = true;
          return;
        }
        nodes.push(out.node);
      }
      for (const child of out.children) flatten(child);
    };
    flatten(result);
    const application = await this.#applicationName(bus).catch(() => undefined);
    return {
      nodes,
      truncated,
      ...(application ? { application } : {}),
    };
  }

  /** A live re-read, or undefined once the element is gone. */
  async element(handle: string): Promise<AccessibilityElement | undefined> {
    const [bus, path] = decodeHandle(handle);
    const raw = await this.#raw(bus, path).catch(() => undefined);
    if (!raw || raw.states.has(STATE.defunct) || !raw.states.has(STATE.showing))
      return undefined;
    return this.#element(raw);
  }

  async #raw(bus: string, path: string): Promise<RawNode> {
    const [role, name, states, children] = await Promise.all([
      this.#call(bus, path, ACCESSIBLE, 'GetRoleName').then((body) =>
        String(body[0] ?? ''),
      ),
      this.#name(bus, path).catch(() => ''),
      this.#states(bus, path),
      this.#children(bus, path).catch(() => []),
    ]);
    return { bus, path, role, name, states, children };
  }

  async #element(raw: RawNode): Promise<AccessibilityElement> {
    const [bounds, value] = await Promise.all([
      this.#call(raw.bus, raw.path, COMPONENT, 'GetExtents', 'u', [
        COORD_SCREEN,
      ]).then(
        (body) => toRegion(body[0]),
        () => undefined,
      ),
      this.#value(raw).catch(() => undefined),
    ]);
    return {
      handle: encodeHandle(raw.bus, raw.path),
      role: raw.role,
      name: raw.name.trim(),
      states: stateNames(raw),
      ...(value !== undefined ? { value } : {}),
      ...(bounds ? { bounds } : {}),
    };
  }

  async #value(raw: RawNode): Promise<string | undefined> {
    if (raw.role === 'password text') return undefined;
    if (VALUE_ROLES.has(raw.role)) {
      const value = await this.#property(
        raw.bus,
        raw.path,
        VALUE,
        'CurrentValue',
      );
      return typeof value === 'number' ? String(value) : undefined;
    }
    if (
      raw.role === 'entry' ||
      raw.role === 'combo box' ||
      (raw.role === 'text' && raw.states.has(STATE.editable))
    ) {
      const body = await this.#call(raw.bus, raw.path, TEXT, 'GetText', 'ii', [
        0,
        MAX_VALUE_CHARACTERS + 1,
      ]);
      const text = String(body[0] ?? '');
      return text.length > MAX_VALUE_CHARACTERS
        ? `${text.slice(0, MAX_VALUE_CHARACTERS)}…`
        : text;
    }
    return undefined;
  }

  async #applications(): Promise<[string, string][]> {
    return this.#children(REGISTRY, ROOT_PATH);
  }

  async #applicationName(bus: string): Promise<string> {
    return this.#name(bus, ROOT_PATH);
  }

  async #children(bus: string, path: string): Promise<[string, string][]> {
    const body = await this.#call(bus, path, ACCESSIBLE, 'GetChildren');
    const children = Array.isArray(body[0]) ? body[0] : [];
    return children.filter(
      (child): child is [string, string] =>
        Array.isArray(child) &&
        typeof child[0] === 'string' &&
        typeof child[1] === 'string' &&
        child[1] !== NULL_PATH,
    );
  }

  async #name(bus: string, path: string): Promise<string> {
    return String((await this.#property(bus, path, ACCESSIBLE, 'Name')) ?? '');
  }

  async #states(bus: string, path: string): Promise<Set<number>> {
    const body = await this.#call(bus, path, ACCESSIBLE, 'GetState');
    const words = Array.isArray(body[0]) ? body[0].map(Number) : [];
    const states = new Set<number>();
    words.forEach((word, index) => {
      for (let bit = 0; bit < 32; bit += 1) {
        if ((word >>> bit) & 1) states.add(index * 32 + bit);
      }
    });
    return states;
  }

  async #property(
    bus: string,
    path: string,
    iface: string,
    name: string,
  ): Promise<unknown> {
    const body = await this.#call(bus, path, PROPERTIES, 'Get', 'ss', [
      iface,
      name,
    ]);
    const variant = body[0];
    return variant && typeof variant === 'object' && 'value' in variant
      ? (variant as { value: unknown }).value
      : variant;
  }

  async #call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
  ): Promise<unknown[]> {
    const connection = await this.#connection();
    return withTimeout(
      connection.call(destination, path, iface, member, signature, body),
      `${member} timed out`,
    );
  }

  async #connection(): Promise<AtspiBus> {
    const current = await this.#bus?.catch(() => undefined);
    if (current?.closed) this.close();
    if (!this.#bus) {
      const bus = this.#address().then((address) => this.#connect(address));
      this.#bus = bus;
      bus.catch(() => {
        if (this.#bus === bus) this.#bus = undefined;
      });
    }
    return this.#bus;
  }
}

function isInteractive(raw: RawNode): boolean {
  if (INTERACTIVE_ROLES.has(raw.role)) return true;
  if (raw.role === 'text' && raw.states.has(STATE.editable)) return true;
  return raw.states.has(STATE.focusable) && raw.name.trim() !== '';
}

function stateNames(raw: RawNode): string[] {
  const { states } = raw;
  const names: string[] = [];
  if (states.has(STATE.focused)) names.push('focused');
  if (states.has(STATE.checked)) names.push('checked');
  else if (states.has(STATE.checkable)) names.push('unchecked');
  if (states.has(STATE.indeterminate)) names.push('mixed');
  if (states.has(STATE.pressed)) names.push('pressed');
  if (states.has(STATE.selected)) names.push('selected');
  if (states.has(STATE.expanded)) names.push('expanded');
  else if (states.has(STATE.expandable) || states.has(STATE.collapsed))
    names.push('collapsed');
  if (
    isInteractive(raw) &&
    !(states.has(STATE.enabled) || states.has(STATE.sensitive))
  )
    names.push('disabled');
  if (states.has(STATE.readOnly)) names.push('read-only');
  if (states.has(STATE.required)) names.push('required');
  if (states.has(STATE.modal)) names.push('modal');
  return names;
}

function toRegion(value: unknown): Region | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const [x, y, width, height] = value.map(Number);
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  return { x: x ?? 0, y: y ?? 0, width, height };
}

/** Rejects with `message` when `promise` takes longer than a D-Bus call may. */
export async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  ms = CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function encodeHandle(bus: string, path: string): string {
  return `${bus}|${path}`;
}

export function decodeHandle(handle: string): [string, string] {
  const split = handle.indexOf('|');
  const bus = handle.slice(0, split);
  const path = handle.slice(split + 1);
  if (split <= 0 || !path.startsWith('/')) {
    throw new Error(`Invalid accessibility handle: ${handle}`);
  }
  return [bus, path];
}

/**
 * The socket path of the first Unix transport in a D-Bus address. Abstract
 * sockets get Node's leading NUL so no native socket module is needed.
 */
export function atspiSocketPath(address: string): string {
  for (const transport of address.split(';')) {
    const colon = transport.indexOf(':');
    if (transport.slice(0, colon) !== 'unix') continue;
    const params = new Map(
      transport
        .slice(colon + 1)
        .split(',')
        .map((pair) => {
          const equals = pair.indexOf('=');
          return [
            pair.slice(0, equals),
            decodeURIComponent(pair.slice(equals + 1)),
          ] as const;
        }),
    );
    const path = params.get('path');
    if (path) return path;
    const abstract = params.get('abstract');
    if (abstract) return `\0${abstract}`;
  }
  throw new Error(`No Unix socket in accessibility bus address: ${address}`);
}

export const connectAtspiBus: AtspiConnector = async (address) => {
  const bus = dbus.sessionBus({
    busAddress: `unix:socket=${atspiSocketPath(address)}`,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.disconnect();
      reject(new Error('Accessibility bus connect timed out'));
    }, CALL_TIMEOUT_MS);
    bus.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    bus.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  let closed = false;
  bus.on('error', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    async call(destination, path, iface, member, signature, body) {
      const reply = await bus.call(
        new dbus.Message({
          destination,
          path,
          interface: iface,
          member,
          ...(signature ? { signature, body: body ?? [] } : {}),
        }),
      );
      return (reply?.body as unknown[] | undefined) ?? [];
    },
    close() {
      closed = true;
      bus.disconnect();
    },
  };
};
