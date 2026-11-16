import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CaptureOptions,
  DesktopInputDeniedError,
  type DesktopProvider,
  DesktopService,
  NO_DESKTOP,
} from '../src/desktop/index.js';
import { desktopFromEnvironment } from '../src/desktop/platform/index.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';

vi.mock('../src/cloud/facts/device-type.js', () => ({
  detectMachineDeviceType: vi.fn(async () => 'laptop'),
}));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fakeProvider(
  screen = { width: 1280, height: 800 },
): DesktopProvider & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return undefined;
    };
  return {
    calls,
    probe: async () => ({ computerUse: true, stream: false, screen }),
    screenSize: async () => screen,
    openStream: () => Promise.reject(new Error('No stream source')),
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
    const backend = fakeProvider({ width: 2560, height: 1600 });
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
    const backend = fakeProvider();
    await new DesktopService(backend).screenshot('png');
    expect(backend.calls).toEqual([['capture', { format: 'png' }]]);
  });

  it('rejects coordinates outside the screenshot', async () => {
    const backend = fakeProvider();
    const desktop = new DesktopService(backend);
    await expect(desktop.move('local', { x: 1280, y: 0 })).rejects.toThrow(
      'outside the 1280x800 screenshot',
    );
    expect(backend.calls).toEqual([]);
  });

  it('zooms a screenshot region from physical pixels', async () => {
    const backend = fakeProvider({ width: 2560, height: 1600 });
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
    const backend = fakeProvider();
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

  it('re-probes failed or partial capabilities sooner than full ones', async () => {
    let now = 0;
    const provider = fakeProvider();
    const screen = { width: 1280, height: 800 };
    const probe = vi
      .fn<DesktopProvider['probe']>()
      .mockRejectedValueOnce(new Error('provider bug'))
      .mockResolvedValueOnce({ computerUse: true, stream: false, screen })
      .mockResolvedValue({ computerUse: true, stream: true, screen });
    provider.probe = probe;
    const desktop = new DesktopService(provider, { now: () => now });

    expect(await desktop.capabilities()).toEqual(NO_DESKTOP);
    now = 10_000;
    expect(await desktop.capabilities()).toMatchObject({ stream: false });
    now = 20_000;
    expect(await desktop.capabilities()).toMatchObject({ stream: true });
    now = 70_000;
    await desktop.capabilities();
    expect(probe).toHaveBeenCalledTimes(3);
    desktop.invalidate();
    await desktop.capabilities();
    expect(probe).toHaveBeenCalledTimes(4);
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
    resources?: { uri: string }[];
    instructions?: string;
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

  it.each([
    ['darwin', ':0'],
    ['win32', ':0'],
    ['linux', undefined],
    ['linux', ':99'],
  ] as const)(
    'are omitted on %s with DISPLAY=%s',
    async (platform, display) => {
      const desktop = desktopFromEnvironment(
        { ...(display ? { DISPLAY: display } : {}), PATH: cwd },
        {},
        platform,
      );
      expect(desktop === undefined).toBe(platform !== 'linux');
      mcp = createMachineMcp(cwd, {
        omitHostDetails: true,
        ...(desktop ? { desktop } : {}),
      });
      const { tools } = await rpc(mcp, 'tools/list');
      const resources = (await rpc(mcp, 'resources/list'))?.resources;
      const init = await rpc(mcp, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(tools?.length).toBeGreaterThan(0);
      expect(tools?.some(({ name }) => name.startsWith('desktop_'))).toBe(
        false,
      );
      expect(resources ?? []).toEqual([]);
      expect(init?.instructions).not.toContain('desktop_*');
    },
  );

  it('are not advertised when the provider reports no computer use', async () => {
    const backend = fakeProvider();
    backend.probe = async () => NO_DESKTOP;
    mcp = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(backend),
    });
    const { tools } = await rpc(mcp, 'tools/list');
    expect(tools?.some(({ name }) => name.startsWith('desktop_'))).toBe(false);
  });

  it('returns screenshots as image content and as a resource', async () => {
    const backend = fakeProvider();
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
    const backend = fakeProvider();
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
    const backend = fakeProvider();
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
    const backend = fakeProvider();
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
    const backend = fakeProvider();
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
