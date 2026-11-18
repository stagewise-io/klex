import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { atspiSocketPath } from '../src/desktop/platform/atspi.js';
import {
  createDesktopProvider,
  toXdotoolCombo,
  X11DesktopProvider,
} from '../src/desktop/platform/index.js';
import type {
  CommandRunner,
  X11DesktopProviderOptions,
} from '../src/desktop/platform/x11.js';
import {
  type DesktopProviderFixture,
  describeDesktopProviderContract,
} from './desktop-provider-contract.js';
import { fakeAtspi, sampleApplication } from './fake-atspi.js';

const VERSION = Buffer.from('RFB 003.008\n', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface FakeX11 {
  /** The X server answers xdotool. */
  display?: boolean;
  /** ImageMagick `import` is installed. */
  imagemagick?: boolean;
  vnc?: 'listening' | 'missing' | 'refusing';
  /** Accessibility is enabled and this bus answers. */
  atspi?: ReturnType<typeof fakeAtspi>;
  /** Overrides for xdotool output by subcommand. */
  xdotool?: Record<string, string>;
}

/** An X11 provider whose exec, launch and socket dependencies are fakes. */
async function fakeX11(
  fake: FakeX11,
  options: Partial<X11DesktopProviderOptions> = { display: ':1' },
): Promise<DesktopProviderFixture & { calls: string[][] }> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-machine-x11-'));
  const vncSocketPath =
    fake.vnc === 'listening' && process.platform === 'win32'
      ? `\\\\.\\pipe\\klex-machine-x11-${randomUUID()}`
      : join(dir, 'vnc.sock');
  let server: Server | undefined;
  if (fake.vnc === 'listening') {
    server = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end(VERSION);
    });
    await new Promise<void>((resolve) =>
      server?.listen(vncSocketPath, resolve),
    );
  } else if (fake.vnc === 'refusing') {
    await writeFile(vncSocketPath, '');
  }
  const calls: string[][] = [];
  const missing = (file: string) =>
    Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'xdotool') {
      if (!fake.display) throw new Error("Can't open display: :1");
      const outputs: Record<string, string> = {
        getdisplaygeometry: '1920 1080\n',
        search: '11\n',
        getactivewindow: '11\n',
        getwindowname: 'Terminal\n',
        getwindowgeometry: 'WINDOW=11\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\n',
        getwindowpid: '777\n',
        ...fake.xdotool,
      };
      return Buffer.from(outputs[args[0] ?? ''] ?? '');
    }
    if (file === 'import') {
      if (!fake.imagemagick) throw missing(file);
      return args[0] === '-version' ? Buffer.from('ImageMagick 7') : JPEG;
    }
    throw missing(file);
  };
  return {
    calls,
    provider: new X11DesktopProvider({
      env: {},
      vncSocketPath,
      run,
      launch: async () => ({ pid: 4242 }),
      connect: (path) => connect(path),
      connectBus: () => Promise.reject(new Error('No accessibility bus')),
      ...(fake.atspi
        ? {
            connectBus: fake.atspi.connect,
            env: { AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/a11y' },
          }
        : {}),
      ...options,
    }),
    async close() {
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      await rm(dir, { force: true, recursive: true });
    },
  };
}

describeDesktopProviderContract(
  'X11 with a live VNC socket',
  { computerUse: true, stream: true },
  () => fakeX11({ display: true, imagemagick: true, vnc: 'listening' }),
);
describeDesktopProviderContract(
  'X11 without a VNC socket',
  { computerUse: true, stream: false },
  () => fakeX11({ display: true, imagemagick: true, vnc: 'missing' }),
);
describeDesktopProviderContract(
  'X11 with a VNC socket path that refuses connections',
  { computerUse: true, stream: false },
  () => fakeX11({ display: true, imagemagick: true, vnc: 'refusing' }),
);
describeDesktopProviderContract(
  'X11 without ImageMagick',
  { computerUse: false, stream: true },
  () => fakeX11({ display: true, imagemagick: false, vnc: 'listening' }),
);
describeDesktopProviderContract(
  'X11 with an accessibility bus',
  { computerUse: true, stream: false, accessibility: true },
  () =>
    fakeX11({
      display: true,
      imagemagick: true,
      vnc: 'missing',
      atspi: fakeAtspi([sampleApplication().app]),
    }),
);
describeDesktopProviderContract(
  'X11 without an accessibility bus',
  { computerUse: true, stream: false },
  () => fakeX11({ display: true, imagemagick: true, vnc: 'missing' }),
);
describeDesktopProviderContract(
  'headless Linux without DISPLAY or VNC',
  { computerUse: false, stream: false },
  () => fakeX11({ vnc: 'missing' }, { display: undefined }),
);
describeDesktopProviderContract(
  'unreachable X display with a live VNC socket',
  { computerUse: false, stream: true },
  () => fakeX11({ display: false, imagemagick: true, vnc: 'listening' }),
);

describe('createDesktopProvider', () => {
  it.each(['freebsd'] as const)('has no provider on %s', (platform) => {
    expect(createDesktopProvider({ DISPLAY: ':0' }, platform)).toBeUndefined();
  });

  it('uses X11 on Linux unless the desktop is turned off', () => {
    expect(createDesktopProvider({}, 'linux')).toBeInstanceOf(
      X11DesktopProvider,
    );
    expect(
      createDesktopProvider(
        { DISPLAY: ':1', KLEX_MACHINE_DESKTOP: 'off' },
        'linux',
      ),
    ).toBeUndefined();
  });

  it('runs nothing on headless Linux', async () => {
    const run = vi.fn<CommandRunner>();
    const connectSocket = vi.fn();
    const provider = new X11DesktopProvider({
      env: {},
      run,
      connect: connectSocket,
    });
    expect(await provider.probe()).toEqual({
      computerUse: false,
      stream: false,
    });
    await expect(provider.openStream()).rejects.toThrow('No X display');
    expect(run).not.toHaveBeenCalled();
    expect(connectSocket).not.toHaveBeenCalled();
  });
});

describe('X11DesktopProvider', () => {
  function backendWith(outputs: Record<string, string> = {}) {
    const calls: [string, string[]][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, [...args]]);
      const key = `${file} ${args[0]}`;
      return Buffer.from(outputs[key] ?? (file === 'import' ? 'img' : ''));
    };
    const backend = new X11DesktopProvider({
      display: ':1',
      env: {},
      run,
      launch: async () => ({ pid: 7 }),
    });
    return { backend, calls };
  }

  it('releases held modifiers when a click fails', async () => {
    const calls: string[][] = [];
    const backend = new X11DesktopProvider({
      display: ':1',
      env: {},
      run: async (_file, args) => {
        calls.push([...args]);
        if (args.includes('click')) throw new Error('timed out');
        return Buffer.from('');
      },
      launch: async () => ({ pid: 7 }),
    });
    await expect(
      backend.click({ x: 1, y: 1 }, 'left', 1, ['ctrl']),
    ).rejects.toThrow('timed out');
    expect(calls.at(-1)).toEqual(['keyup', 'ctrl']);
  });

  it('builds xdotool argument vectors without a shell', async () => {
    const { backend, calls } = backendWith();
    await backend.click({ x: 5, y: 6 }, 'right', 2, ['Ctrl', 'shift']);
    await backend.type('a; rm -rf / $(x)');
    await backend.key(['cmd+L', 'Enter', 'ctrl+shift+t', 'f5']);
    await backend.scroll({ x: 1, y: 2 }, 'down', 4);

    expect(calls).toEqual([
      ['xdotool', ['keydown', 'ctrl', 'keydown', 'shift']],
      [
        'xdotool',
        ['mousemove', '5', '6', 'click', '--repeat', '2', '--delay', '80', '3'],
      ],
      ['xdotool', ['keyup', 'shift', 'keyup', 'ctrl']],
      [
        'xdotool',
        ['type', '--clearmodifiers', '--delay', '12', '--', 'a; rm -rf / $(x)'],
      ],
      [
        'xdotool',
        [
          'key',
          '--clearmodifiers',
          '--delay',
          '40',
          '--',
          'super+L',
          'Return',
          'ctrl+shift+t',
          'F5',
        ],
      ],
      [
        'xdotool',
        ['mousemove', '1', '2', 'click', '--repeat', '4', '--delay', '30', '5'],
      ],
    ]);
  });

  it('captures regions with ImageMagick', async () => {
    const { backend, calls } = backendWith();
    await backend.capture({
      region: { x: 1, y: 2, width: 3, height: 4 },
      size: { width: 30, height: 40 },
      format: 'jpeg',
    });
    expect(calls).toEqual([
      [
        'import',
        [
          '-silent',
          '-window',
          'root',
          '-crop',
          '3x4+1+2',
          '+repage',
          '-resize',
          '30x40!',
          '-quality',
          '75',
          'jpeg:-',
        ],
      ],
    ]);
  });

  it('parses the display geometry and window list', async () => {
    const { backend } = backendWith({
      'xdotool getdisplaygeometry': '1280 800\n',
      'xdotool search': '11\n12\n',
      'xdotool getactivewindow': '12\n',
      'xdotool getwindowname': 'Title\n',
      'xdotool getwindowgeometry':
        'WINDOW=12\nX=10\nY=20\nWIDTH=300\nHEIGHT=200\nSCREEN=0\n',
    });
    expect(await backend.screenSize()).toEqual({ width: 1280, height: 800 });
    expect(await backend.listWindows()).toEqual([
      {
        id: '11',
        title: 'Title',
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: false,
      },
      {
        id: '12',
        title: 'Title',
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      },
    ]);
  });

  it('rejects unknown key names', () => {
    expect(toXdotoolCombo('Ctrl+Alt+Delete')).toBe('ctrl+alt+Delete');
    expect(() => toXdotoolCombo('ctrl+')).toThrow('Invalid key combo');
    expect(() => toXdotoolCombo('ctrl+$(x)')).toThrow('Unsupported key name');
  });
});

describe('X11 accessibility', () => {
  const query = { interactiveOnly: true, maxDepth: 30, maxNodes: 300 };

  it('reports accessibility from the probe alone, with no setting', async () => {
    const atspi = fakeAtspi([sampleApplication().app]);
    const withBus = await fakeX11(
      { display: true, imagemagick: true, vnc: 'missing', atspi },
      { display: ':1', env: { AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/a11y' } },
    );
    const withoutBus = await fakeX11({
      display: true,
      imagemagick: true,
      vnc: 'missing',
    });
    try {
      expect((await withBus.provider.probe()).accessibility).toBe(true);
      expect(await withoutBus.provider.probe()).not.toHaveProperty(
        'accessibility',
      );
    } finally {
      await withBus.close?.();
      await withoutBus.close?.();
    }
  });

  it('leaves accessibility off with the whole desktop when KLEX_MACHINE_DESKTOP=off', () => {
    expect(
      createDesktopProvider(
        { DISPLAY: ':0', KLEX_MACHINE_DESKTOP: 'off' },
        'linux',
      ),
    ).toBeUndefined();
  });

  it('reports nothing on a headless machine', async () => {
    const atspi = fakeAtspi([sampleApplication().app]);
    const fixture = await fakeX11(
      { vnc: 'missing', atspi },
      { display: undefined },
    );
    try {
      expect(await fixture.provider.probe()).toEqual({
        computerUse: false,
        stream: false,
      });
      expect(atspi.connections).toEqual([]);
    } finally {
      await fixture.close?.();
    }
  });

  it('prints controls of the focused window, skipping hidden nodes, wrappers and passwords', async () => {
    const atspi = fakeAtspi([sampleApplication().app]);
    const fixture = await fakeX11({ display: true, imagemagick: true, atspi });
    try {
      const tree = await fixture.provider.accessibilityTree?.(query);
      expect(tree).toMatchObject({
        application: 'xfce4-terminal',
        window: 'Terminal',
        truncated: false,
      });
      expect(
        tree?.nodes.map(({ depth, role, name, value, states, bounds }) => ({
          depth,
          role,
          name,
          value,
          states,
          bounds,
        })),
      ).toEqual([
        {
          depth: 0,
          role: 'frame',
          name: 'Terminal',
          value: undefined,
          states: [],
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
        {
          depth: 1,
          role: 'push button',
          name: 'Save',
          value: undefined,
          states: ['focused'],
          bounds: { x: 100, y: 50, width: 80, height: 30 },
        },
        {
          depth: 1,
          role: 'entry',
          name: 'Search',
          value: 'hello',
          states: [],
          bounds: { x: 200, y: 50, width: 300, height: 30 },
        },
        {
          depth: 1,
          role: 'password text',
          name: 'Password',
          value: undefined,
          states: [],
          bounds: { x: 200, y: 100, width: 300, height: 30 },
        },
        {
          depth: 1,
          role: 'check box',
          name: 'Remember',
          value: undefined,
          states: ['unchecked', 'disabled'],
          bounds: { x: 200, y: 150, width: 20, height: 20 },
        },
      ]);
      expect(atspi.calls).toContainEqual({
        destination: ':1.42',
        member: 'GetAttributes',
        address: 'unix:path=/tmp/a11y',
      });

      const all = await fixture.provider.accessibilityTree?.({
        ...query,
        interactiveOnly: false,
      });
      expect(all?.nodes.map(({ name }) => name)).toContain('Status');
      expect(all?.nodes.map(({ name }) => name)).not.toContain('Hidden');
      expect(all?.nodes.map(({ role }) => role)).not.toContain('panel');
    } finally {
      await fixture.close?.();
    }
  });

  it('marks trees cut by maxDepth or maxNodes as truncated', async () => {
    const fixture = await fakeX11({
      display: true,
      imagemagick: true,
      atspi: fakeAtspi([sampleApplication().app]),
    });
    try {
      const shallow = await fixture.provider.accessibilityTree?.({
        ...query,
        maxDepth: 1,
      });
      expect(shallow?.nodes.map(({ role }) => role)).toEqual(['frame']);
      expect(shallow?.truncated).toBe(true);
      const small = await fixture.provider.accessibilityTree?.({
        ...query,
        maxNodes: 2,
      });
      expect(small?.nodes).toHaveLength(2);
      expect(small?.truncated).toBe(true);
    } finally {
      await fixture.close?.();
    }
  });

  it('matches the window by title when its process is unknown', async () => {
    const fixture = await fakeX11({
      display: true,
      imagemagick: true,
      atspi: fakeAtspi([sampleApplication().app]),
      xdotool: { getwindowpid: '' },
    });
    try {
      const tree = await fixture.provider.accessibilityTree?.(query);
      expect(tree?.nodes[0]?.name).toBe('Terminal');
    } finally {
      await fixture.close?.();
    }
  });

  it('explains how to get a tree when the window exposes none', async () => {
    const fixture = await fakeX11({
      display: true,
      imagemagick: true,
      atspi: fakeAtspi([sampleApplication().app]),
      xdotool: { getwindowpid: '1\n', getwindowname: 'Canvas game\n' },
    });
    try {
      await expect(fixture.provider.accessibilityTree?.(query)).rejects.toThrow(
        /Window "Canvas game" exposes no accessibility tree.*--force-renderer-accessibility.*desktop_screenshot/,
      );
    } finally {
      await fixture.close?.();
    }
  });

  it('re-reads elements live and reports removed ones as gone', async () => {
    const { app, save } = sampleApplication();
    const atspi = fakeAtspi([app]);
    const fixture = await fakeX11({ display: true, imagemagick: true, atspi });
    try {
      const tree = await fixture.provider.accessibilityTree?.(query);
      const handle = tree?.nodes.find(({ name }) => name === 'Save')?.handle;
      expect(handle).toBeDefined();
      expect(
        await fixture.provider.accessibilityElement?.(handle ?? ''),
      ).toMatchObject({ role: 'push button', name: 'Save' });
      atspi.remove(save);
      expect(
        await fixture.provider.accessibilityElement?.(handle ?? ''),
      ).toBeUndefined();
      await expect(
        fixture.provider.accessibilityTree?.({ ...query, root: handle }),
      ).rejects.toThrow('gone');
    } finally {
      await fixture.close?.();
    }
  });

  it('treats hidden elements and children of removed ones as gone', async () => {
    const { app, save } = sampleApplication();
    const atspi = fakeAtspi([app]);
    const fixture = await fakeX11({ display: true, imagemagick: true, atspi });
    try {
      const tree = await fixture.provider.accessibilityTree?.(query);
      const handleOf = (name: string) =>
        tree?.nodes.find((node) => node.name === name)?.handle ?? '';
      atspi.hide(save);
      expect(
        await fixture.provider.accessibilityElement?.(handleOf('Save')),
      ).toBeUndefined();
      const panel = app.windows[0]?.children?.[0];
      if (!panel) throw new Error('sample has no panel');
      atspi.remove(panel);
      expect(
        await fixture.provider.accessibilityElement?.(handleOf('Search')),
      ).toBeUndefined();
    } finally {
      await fixture.close?.();
    }
  });

  it('stops walking once maxNodes elements are kept', async () => {
    const atspi = fakeAtspi([sampleApplication().app]);
    const fixture = await fakeX11({ display: true, imagemagick: true, atspi });
    try {
      await fixture.provider.accessibilityTree?.({ ...query, maxNodes: 1 });
      const roleReads = atspi.calls.filter(
        ({ member }) => member === 'GetRoleName',
      ).length;
      expect(roleReads).toBeLessThan(4);
    } finally {
      await fixture.close?.();
    }
  });

  it('gives up on a session bus launcher that never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const provider = new X11DesktopProvider({
        display: ':1',
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        vncSocketPath: '/nonexistent/vnc.sock',
        connect: () => {
          throw new Error('no socket');
        },
        connectBus: async () => ({
          closed: false,
          call: () => new Promise<never>(() => undefined),
          close() {},
        }),
        run: async (file) => {
          if (file === 'xprop') throw new Error('no property');
          return Buffer.from(file === 'xdotool' ? '1280 800\n' : '');
        },
      });
      const probe = provider.probe();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await probe).not.toHaveProperty('accessibility');
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the bus from the root window, then from the session bus', async () => {
    const atspi = fakeAtspi([sampleApplication().app], {
      a11yAddress: 'unix:path=/run/user/1000/at-spi/bus_1',
    });
    const fromRoot = new X11DesktopProvider({
      display: ':1',
      env: {},
      connectBus: atspi.connect,
      run: async (file, args) => {
        if (file === 'xprop' && args.join(' ') === '-root AT_SPI_BUS') {
          return Buffer.from(
            'AT_SPI_BUS(STRING) = "unix:abstract=/tmp/dbus-x"\n',
          );
        }
        if (file === 'xdotool') return Buffer.from('1280 800\n');
        return Buffer.from('');
      },
    });
    expect((await fromRoot.probe()).accessibility).toBe(true);
    expect(atspi.connections).toEqual(['unix:abstract=/tmp/dbus-x']);

    atspi.connections.length = 0;
    const fromSession = new X11DesktopProvider({
      display: ':1',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      connectBus: atspi.connect,
      run: async (file) => {
        if (file === 'xprop') throw new Error('no property');
        return Buffer.from(file === 'xdotool' ? '1280 800\n' : '');
      },
    });
    expect((await fromSession.probe()).accessibility).toBe(true);
    expect(atspi.connections).toEqual([
      'unix:path=/run/user/1000/bus',
      'unix:path=/run/user/1000/at-spi/bus_1',
    ]);
  });

  it('reads socket paths from D-Bus addresses', () => {
    expect(atspiSocketPath('unix:path=/run/user/1000/at-spi/bus_1')).toBe(
      '/run/user/1000/at-spi/bus_1',
    );
    expect(
      atspiSocketPath('unix:abstract=/tmp/dbus-AbC,guid=0123456789abcdef'),
    ).toBe('\0/tmp/dbus-AbC');
    expect(atspiSocketPath('tcp:host=x,port=1;unix:path=/a%20b')).toBe('/a b');
    expect(() => atspiSocketPath('tcp:host=x,port=1')).toThrow(
      'No Unix socket',
    );
  });
});
