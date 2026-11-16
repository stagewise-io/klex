import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CaptureOptions,
  type DesktopBackend,
  DesktopInputDeniedError,
  DesktopService,
  toXdotoolCombo,
  X11DesktopBackend,
} from '../src/desktop/index.js';
import type { CommandRunner } from '../src/desktop/x11.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';

vi.mock('../src/cloud/facts/device-type.js', () => ({
  detectMachineDeviceType: vi.fn(async () => 'laptop'),
}));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fakeBackend(
  screen = { width: 1280, height: 800 },
): DesktopBackend & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return undefined;
    };
  return {
    calls,
    probe: async () => screen,
    capture: async (options: CaptureOptions) => {
      calls.push(['capture', options]);
      return JPEG;
    },
    click: record('click'),
    drag: record('drag'),
    move: record('move'),
    scroll: record('scroll'),
    type: record('type'),
    key: record('key'),
    focusWindow: record('focusWindow'),
    listWindows: async () => [
      {
        id: '42',
        title: 'Chrome',
        bounds: { x: 100, y: 200, width: 1000, height: 600 },
        focused: true,
      },
    ],
    launch: async (options) => {
      calls.push(['launch', options]);
      return { pid: 1234 };
    },
  };
}

describe('DesktopService', () => {
  it('maps screenshot coordinates to a larger physical screen', async () => {
    const backend = fakeBackend({ width: 2560, height: 1600 });
    const desktop = new DesktopService(backend);

    const shot = await desktop.screenshot();
    await desktop.click('local', { x: 100, y: 50 }, 'left', 2, ['ctrl']);
    const windows = await desktop.listWindows();

    expect(shot).toMatchObject({
      width: 1280,
      height: 800,
      mimeType: 'image/jpeg',
      screen: { width: 2560, height: 1600 },
    });
    expect(backend.calls).toContainEqual([
      'capture',
      { format: 'jpeg', size: { width: 1280, height: 800 } },
    ]);
    expect(backend.calls).toContainEqual([
      'click',
      { x: 200, y: 100 },
      'left',
      2,
      ['ctrl'],
    ]);
    expect(windows[0]?.bounds).toEqual({
      x: 50,
      y: 100,
      width: 500,
      height: 300,
    });
  });

  it('captures at native size when the screen fits', async () => {
    const backend = fakeBackend();
    await new DesktopService(backend).screenshot('png');
    expect(backend.calls).toEqual([['capture', { format: 'png' }]]);
  });

  it('rejects coordinates outside the screenshot', async () => {
    const backend = fakeBackend();
    const desktop = new DesktopService(backend);
    await expect(desktop.move('local', { x: 1280, y: 0 })).rejects.toThrow(
      'outside the 1280x800 screenshot',
    );
    expect(backend.calls).toEqual([]);
  });

  it('zooms a screenshot region from physical pixels', async () => {
    const backend = fakeBackend({ width: 2560, height: 1600 });
    const zoom = await new DesktopService(backend).zoom({
      x: 10,
      y: 20,
      width: 320,
      height: 200,
    });
    expect(backend.calls).toContainEqual([
      'capture',
      {
        region: { x: 20, y: 40, width: 640, height: 400 },
        size: { width: 1280, height: 800 },
        format: 'jpeg',
      },
    ]);
    expect(zoom).toMatchObject({ width: 1280, height: 800 });
  });

  it('asks the input control before every input action, at execution time', async () => {
    const backend = fakeBackend();
    const authorize = vi.fn(({ action }: { action: string }) => {
      if (action === 'type')
        throw new DesktopInputDeniedError('Alex has control', {
          holder: 'user_1',
        });
    });
    const desktop = new DesktopService(backend, {
      inputControl: { authorize },
    });

    await desktop.key('p1', ['Enter']);
    await expect(desktop.type('p1', 'secret')).rejects.toBeInstanceOf(
      DesktopInputDeniedError,
    );
    await desktop.screenshot();

    expect(authorize.mock.calls.map(([request]) => request)).toEqual([
      { action: 'key', principalId: 'p1' },
      { action: 'type', principalId: 'p1' },
    ]);
    expect(backend.calls.map(([name]) => name)).toEqual(['key', 'capture']);
  });

  it('reports unavailable when the probe fails and retries after a backoff', async () => {
    let now = 0;
    const backend = fakeBackend();
    const probe = vi
      .fn<DesktopBackend['probe']>()
      .mockRejectedValueOnce(new Error('Cannot open display'))
      .mockResolvedValue({ width: 1280, height: 800 });
    backend.probe = probe;
    const desktop = new DesktopService(backend, { now: () => now });

    expect(await desktop.available()).toBe(false);
    expect(await desktop.available()).toBe(false);
    now = 10_000;
    expect(await desktop.available()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('X11DesktopBackend', () => {
  function backendWith(outputs: Record<string, string> = {}) {
    const calls: [string, string[]][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, [...args]]);
      const key = `${file} ${args[0]}`;
      return Buffer.from(outputs[key] ?? (file === 'import' ? 'img' : ''));
    };
    const backend = new X11DesktopBackend({
      display: ':1',
      env: {},
      run,
      launch: async () => ({ pid: 7 }),
    });
    return { backend, calls };
  }

  it('builds xdotool argument vectors without a shell', async () => {
    const { backend, calls } = backendWith();
    await backend.click({ x: 5, y: 6 }, 'right', 2, ['Ctrl', 'shift']);
    await backend.type('a; rm -rf / $(x)');
    await backend.key(['cmd+L', 'Enter', 'ctrl+shift+t', 'f5']);
    await backend.scroll({ x: 1, y: 2 }, 'down', 4);

    expect(calls).toEqual([
      [
        'xdotool',
        [
          'keydown',
          'ctrl',
          'keydown',
          'shift',
          'mousemove',
          '--sync',
          '5',
          '6',
          'click',
          '--repeat',
          '2',
          '--delay',
          '80',
          '3',
          'keyup',
          'shift',
          'keyup',
          'ctrl',
        ],
      ],
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
        [
          'mousemove',
          '--sync',
          '1',
          '2',
          'click',
          '--repeat',
          '4',
          '--delay',
          '30',
          '5',
        ],
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
    expect(await backend.probe()).toEqual({ width: 1280, height: 800 });
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

interface RpcResult {
  result: {
    content?: {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }[];
    contents?: { uri: string; mimeType?: string; blob?: string }[];
    isError?: boolean;
    tools?: { name: string }[];
  };
}

async function rpc(
  mcp: MachineMcp,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResult['result']> {
  const response = await mcp.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return (JSON.parse(data ?? text) as RpcResult).result;
}

describe('desktop MCP tools', () => {
  let cwd: string;
  let mcp: MachineMcp | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'klex-machine-desktop-'));
  });

  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await rm(cwd, { force: true, recursive: true });
  });

  it('are not advertised without a reachable display', async () => {
    const backend = fakeBackend();
    backend.probe = async () => {
      throw new Error('Cannot open display');
    };
    mcp = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(backend),
    });
    const { tools } = await rpc(mcp, 'tools/list');
    expect(tools?.some(({ name }) => name.startsWith('desktop_'))).toBe(false);
  });

  it('returns screenshots as image content and as a resource', async () => {
    const backend = fakeBackend();
    mcp = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(backend),
    });

    const { tools } = await rpc(mcp, 'tools/list');
    expect(
      tools
        ?.filter(({ name }) => name.startsWith('desktop_'))
        .map(({ name }) => name),
    ).toEqual([
      'desktop_screenshot',
      'desktop_zoom',
      'desktop_click',
      'desktop_drag',
      'desktop_move',
      'desktop_scroll',
      'desktop_type',
      'desktop_key',
      'desktop_list_windows',
      'desktop_focus_window',
      'desktop_launch',
    ]);

    const shot = await rpc(mcp, 'tools/call', {
      name: 'desktop_screenshot',
      arguments: {},
    });
    expect(shot.content).toEqual([
      { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' },
      {
        type: 'text',
        text: JSON.stringify({
          width: 1280,
          height: 800,
          screen: { width: 1280, height: 800 },
        }),
      },
    ]);

    const resource = await rpc(mcp, 'resources/read', {
      uri: 'desktop://screen',
    });
    expect(resource.contents).toEqual([
      {
        uri: 'desktop://screen',
        mimeType: 'image/jpeg',
        blob: JPEG.toString('base64'),
      },
    ]);
  });

  it('appends a settled screenshot only when asked', async () => {
    const backend = fakeBackend();
    mcp = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(backend, { sleep: async () => undefined }),
    });

    const plain = await rpc(mcp, 'tools/call', {
      name: 'desktop_click',
      arguments: { x: 10, y: 20 },
    });
    const withShot = await rpc(mcp, 'tools/call', {
      name: 'desktop_key',
      arguments: { keys: ['Enter'], screenshot: true },
    });

    expect(plain.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(withShot.content?.map(({ type }) => type)).toEqual([
      'text',
      'image',
      'text',
    ]);
  });

  it('captures the follow-up screenshot before any other queued action', async () => {
    const backend = fakeBackend();
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const desktop = new DesktopService(backend, { sleep: () => settled });
    const shot = desktop.withSettledScreenshot(() =>
      desktop.click('bot-1', { x: 1, y: 1 }, 'left', 1, []),
    );
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1));
    const other = desktop.click('bot-2', { x: 2, y: 2 }, 'left', 1, []);
    release();
    await Promise.all([shot, other]);
    expect(backend.calls.map(([name]) => name)).toEqual([
      'click',
      'capture',
      'click',
    ]);
  });

  it('launches apps from the machine working directory', async () => {
    const backend = fakeBackend();
    mcp = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(backend),
    });
    await rpc(mcp, 'tools/call', {
      name: 'desktop_launch',
      arguments: { command: 'browser' },
    });
    await rpc(mcp, 'tools/call', {
      name: 'desktop_launch',
      arguments: { command: 'browser', cwd: 'sub' },
    });
    expect(backend.calls).toEqual([
      ['launch', { command: 'browser', args: [], cwd }],
      ['launch', { command: 'browser', args: [], cwd: join(cwd, 'sub') }],
    ]);
  });

  it('returns a structured error when a human holds control', async () => {
    const backend = fakeBackend();
    mcp = createMachineMcp(cwd, {
      principalId: 'agent-1',
      omitHostDetails: true,
      desktop: new DesktopService(backend, {
        inputControl: {
          authorize: () => {
            throw new DesktopInputDeniedError('A person is using the desktop', {
              holder: 'user_1',
            });
          },
        },
      }),
    });

    const result = await rpc(mcp, 'tools/call', {
      name: 'desktop_type',
      arguments: { text: 'hello' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? '')).toEqual({
      error: {
        code: 'desktop_controlled_by_user',
        message: 'A person is using the desktop',
        holder: 'user_1',
      },
    });
    expect(backend.calls).toEqual([]);
  });
});
