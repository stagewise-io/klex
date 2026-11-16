import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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

const VERSION = Buffer.from('RFB 003.008\n', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface FakeX11 {
  /** The X server answers xdotool. */
  display?: boolean;
  /** ImageMagick `import` is installed. */
  imagemagick?: boolean;
  vnc?: 'listening' | 'missing' | 'refusing';
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
  it.each(['darwin', 'win32', 'freebsd'] as const)(
    'has no provider on %s',
    (platform) => {
      expect(
        createDesktopProvider({ DISPLAY: ':0' }, platform),
      ).toBeUndefined();
    },
  );

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
