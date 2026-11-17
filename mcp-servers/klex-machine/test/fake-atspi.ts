import type { AtspiBus } from '../src/desktop/platform/atspi.js';

/** AtspiStateType bit positions, kept independent of the client's table. */
const STATE_BITS: Record<string, number> = {
  active: 1,
  checked: 4,
  defunct: 6,
  editable: 7,
  enabled: 8,
  focusable: 11,
  focused: 12,
  sensitive: 24,
  showing: 25,
  visible: 30,
  checkable: 41,
};

export interface FakeElement {
  role: string;
  name?: string;
  states?: string[];
  bounds?: [number, number, number, number];
  text?: string;
  value?: number;
  children?: FakeElement[];
}

export interface FakeApplication {
  bus: string;
  pid: number;
  name: string;
  windows: FakeElement[];
}

const ROOT = '/org/a11y/atspi/accessible/root';

/**
 * An in-memory AT-SPI2 registry and its applications behind the `AtspiBus`
 * interface. `remove()` makes an element vanish the way a closed dialog does.
 */
export function fakeAtspi(
  applications: FakeApplication[],
  options: { a11yAddress?: string } = {},
) {
  const nodes = new Map<string, FakeElement>();
  const paths = new Map<FakeElement, string>();
  const removed = new Set<FakeElement>();
  let next = 1;
  const register = (bus: string, element: FakeElement) => {
    const path = `/org/a11y/atspi/accessible/${next++}`;
    nodes.set(`${bus}|${path}`, element);
    paths.set(element, path);
    for (const child of element.children ?? []) register(bus, child);
  };
  for (const app of applications) {
    for (const window of app.windows) register(app.bus, window);
  }
  const calls: { destination: string; member: string; address: string }[] = [];
  const connections: string[] = [];
  const visible = (bus: string, list: FakeElement[]) =>
    list
      .filter((child) => !removed.has(child))
      .map((child) => [bus, paths.get(child)]);

  const handle = (
    destination: string,
    path: string,
    iface: string,
    member: string,
    body: unknown[],
  ): unknown[] => {
    if (destination === 'org.a11y.atspi.Registry' && path === ROOT) {
      if (member === 'GetChildren') {
        return [applications.map((app) => [app.bus, ROOT])];
      }
    }
    if (iface === 'org.freedesktop.DBus') {
      const app = applications.find((candidate) => candidate.bus === body[0]);
      if (member === 'GetConnectionUnixProcessID' && app) return [app.pid];
    }
    if (iface === 'org.a11y.Bus' && member === 'GetAddress') {
      return [options.a11yAddress ?? 'unix:path=/tmp/fake-a11y'];
    }
    const app = applications.find((candidate) => candidate.bus === destination);
    if (app && path === ROOT) {
      if (member === 'GetChildren') return [visible(app.bus, app.windows)];
      if (member === 'Get' && body[1] === 'Name') return [{ value: app.name }];
    }
    const element = nodes.get(`${destination}|${path}`);
    if (!element || removed.has(element)) {
      throw new Error('org.freedesktop.DBus.Error.UnknownObject');
    }
    switch (`${iface}.${member}`) {
      case 'org.a11y.atspi.Accessible.GetRoleName':
        return [element.role];
      case 'org.a11y.atspi.Accessible.GetChildren':
        return [visible(destination, element.children ?? [])];
      case 'org.a11y.atspi.Accessible.GetAttributes':
        return [{}];
      case 'org.a11y.atspi.Accessible.GetState': {
        const words = [0, 0];
        for (const state of element.states ?? []) {
          const bit = STATE_BITS[state];
          if (bit === undefined) throw new Error(`Unknown state ${state}`);
          words[bit >> 5] = ((words[bit >> 5] ?? 0) | (1 << (bit & 31))) >>> 0;
        }
        return [words];
      }
      case 'org.a11y.atspi.Component.GetExtents':
        if (!element.bounds) throw new Error('No Component interface');
        return [element.bounds];
      case 'org.a11y.atspi.Text.GetText':
        if (element.text === undefined) throw new Error('No Text interface');
        return [element.text.slice(Number(body[0]), Number(body[1]))];
      case 'org.freedesktop.DBus.Properties.Get':
        if (body[0] === 'org.a11y.atspi.Accessible' && body[1] === 'Name') {
          return [{ value: element.name ?? '' }];
        }
        if (
          body[0] === 'org.a11y.atspi.Accessible' &&
          body[1] === 'ChildCount'
        ) {
          return [{ value: (element.children ?? []).length }];
        }
        if (body[0] === 'org.a11y.atspi.Value' && element.value !== undefined) {
          return [{ value: element.value }];
        }
        throw new Error('org.freedesktop.DBus.Error.UnknownProperty');
    }
    throw new Error(`org.freedesktop.DBus.Error.UnknownMethod: ${member}`);
  };

  return {
    calls,
    connections,
    remove(element: FakeElement) {
      removed.add(element);
    },
    async connect(address: string): Promise<AtspiBus> {
      connections.push(address);
      return {
        closed: false,
        async call(destination, path, iface, member, _signature, body = []) {
          calls.push({ destination, member, address });
          return handle(destination, path, iface, member, body);
        },
        close() {},
      };
    },
  };
}

/** One terminal-like window with a mix of controls, labels and hidden nodes. */
export function sampleApplication(): {
  app: FakeApplication;
  save: FakeElement;
} {
  const save: FakeElement = {
    role: 'push button',
    name: 'Save',
    states: [
      'showing',
      'visible',
      'enabled',
      'sensitive',
      'focusable',
      'focused',
    ],
    bounds: [100, 50, 80, 30],
  };
  const app: FakeApplication = {
    bus: ':1.42',
    pid: 777,
    name: 'xfce4-terminal',
    windows: [
      {
        role: 'frame',
        name: 'Terminal',
        states: ['active', 'showing', 'visible', 'enabled', 'sensitive'],
        bounds: [0, 0, 800, 600],
        children: [
          {
            role: 'panel',
            states: ['showing', 'visible'],
            bounds: [0, 0, 800, 600],
            children: [
              save,
              {
                role: 'entry',
                name: 'Search',
                text: 'hello',
                states: [
                  'showing',
                  'visible',
                  'enabled',
                  'sensitive',
                  'editable',
                  'focusable',
                ],
                bounds: [200, 50, 300, 30],
              },
              {
                role: 'password text',
                name: 'Password',
                text: 'secret',
                states: [
                  'showing',
                  'visible',
                  'enabled',
                  'sensitive',
                  'editable',
                  'focusable',
                ],
                bounds: [200, 100, 300, 30],
              },
              {
                role: 'check box',
                name: 'Remember',
                states: ['showing', 'visible', 'checkable'],
                bounds: [200, 150, 20, 20],
              },
              {
                role: 'label',
                name: 'Status',
                states: ['showing', 'visible'],
                bounds: [0, 580, 800, 20],
              },
              {
                role: 'push button',
                name: 'Hidden',
                states: ['visible', 'enabled', 'sensitive'],
                bounds: [0, 0, 10, 10],
              },
            ],
          },
        ],
      },
    ],
  };
  return { app, save };
}
