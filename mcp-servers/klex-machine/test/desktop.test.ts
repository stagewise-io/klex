import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccessibilityElement,
  type AccessibilityNode,
  type AccessibilityQuery,
  type AccessibilityTree,
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

/** A provider that reports accessibility over a fixed, mutable tree. */
function accessibleProvider(screen = { width: 2560, height: 1600 }) {
  const backend = fakeProvider(screen);
  const nodes: AccessibilityNode[] = [
    {
      handle: 'app|/frame',
      role: 'frame',
      name: 'Editor',
      states: [],
      bounds: { x: 0, y: 0, width: 2560, height: 1600 },
      depth: 0,
    },
    {
      handle: 'app|/save',
      role: 'push button',
      name: 'Save',
      states: ['focused'],
      bounds: { x: 200, y: 100, width: 160, height: 60 },
      depth: 1,
    },
    {
      handle: 'app|/search',
      role: 'entry',
      name: 'Search "all"',
      value: 'hello',
      states: [],
      bounds: { x: 400, y: 100, width: 600, height: 60 },
      depth: 1,
    },
  ];
  const live = new Map<string, AccessibilityElement>(
    nodes.map(({ depth: _depth, ...element }) => [element.handle, element]),
  );
  const queries: unknown[] = [];
  const update = (handle: string, changes: Partial<AccessibilityElement>) => {
    const element = live.get(handle);
    if (!element) throw new Error(`No element ${handle}`);
    live.set(handle, { ...element, ...changes });
  };
  const provider = Object.assign(backend, {
    live,
    update,
    queries,
    probe: async () => ({
      computerUse: true,
      stream: false,
      accessibility: true,
      screen,
    }),
    accessibilityTree: async (
      query: AccessibilityQuery,
    ): Promise<AccessibilityTree> => {
      queries.push(query);
      const start = query.root
        ? nodes.findIndex((node) => node.handle === query.root)
        : 0;
      if (start < 0 || !live.has(nodes[start]?.handle ?? '')) {
        throw new Error('The accessibility element is gone');
      }
      return {
        application: 'editor',
        window: 'Editor',
        nodes: query.root
          ? nodes.slice(start, start + 1).map((node) => ({ ...node, depth: 0 }))
          : nodes,
        truncated: false,
      };
    },
    accessibilityElement: async (handle: string) => live.get(handle),
  });
  return provider;
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

  it('prints accessibility trees with stable refs in screenshot coordinates', async () => {
    const backend = accessibleProvider();
    const desktop = new DesktopService(backend);

    const tree = await desktop.accessibilityTree();
    expect(tree.text.split('\n')).toEqual([
      'window "Editor", application "editor"',
      'r1 frame "Editor" @0,0 1280x800',
      '  r2 push button "Save" @100,50 80x30 [focused]',
      '  r3 entry "Search \\"all\\"" value="hello" @200,50 300x30',
    ]);
    expect(tree).toMatchObject({ nodes: 3, truncated: false });
    expect(backend.queries).toEqual([
      { interactiveOnly: true, maxDepth: 30, maxNodes: 300 },
    ]);

    const again = await desktop.accessibilityTree({
      ref: 'r2',
      interactiveOnly: false,
      maxDepth: 500,
      maxNodes: 5,
    });
    expect(again.text.split('\n')[1]).toBe(
      'r2 push button "Save" @100,50 80x30 [focused]',
    );
    expect(backend.queries[1]).toEqual({
      root: 'app|/save',
      interactiveOnly: false,
      maxDepth: 60,
      maxNodes: 5,
    });
  });

  it('suggests screenshots when a window exposes only its frame', async () => {
    const backend = accessibleProvider();
    backend.accessibilityTree = async () => ({
      window: 'Game',
      nodes: [
        {
          handle: 'app|/frame',
          role: 'frame',
          name: 'Game',
          states: [],
          depth: 0,
        },
      ],
      truncated: false,
    });
    const tree = await new DesktopService(backend).accessibilityTree();
    expect(tree.text).toContain('Only the window itself is exposed');
    expect(tree.text).toContain('desktop_screenshot');
  });

  it('clicks an element by ref at its live centre', async () => {
    const backend = accessibleProvider();
    const desktop = new DesktopService(backend);
    await desktop.accessibilityTree();
    backend.update('app|/save', {
      bounds: { x: 1000, y: 1000, width: 100, height: 40 },
    });

    expect(await desktop.clickElement('local', 'r2', 'left', 1, [])).toEqual({
      ref: 'r2',
      x: 525,
      y: 510,
    });
    expect(backend.calls).toContainEqual([
      'click',
      { x: 1050, y: 1020 },
      'left',
      1,
      [],
    ]);
  });

  it('refuses stale, unknown, off-screen and unauthorized element clicks', async () => {
    const backend = accessibleProvider();
    const authorize = vi.fn();
    const desktop = new DesktopService(backend, {
      inputControl: { authorize },
    });
    await desktop.accessibilityTree();

    await expect(
      desktop.clickElement('local', 'r99', 'left', 1, []),
    ).rejects.toThrow('r99 is stale or unknown');
    backend.update('app|/search', {
      role: 'label',
    });
    await expect(
      desktop.clickElement('local', 'r3', 'left', 1, []),
    ).rejects.toThrow('r3 is stale or unknown');
    backend.update('app|/save', {
      bounds: { x: 3000, y: 0, width: 10, height: 10 },
    });
    await expect(
      desktop.clickElement('local', 'r2', 'left', 1, []),
    ).rejects.toThrow('r2 is off screen');
    backend.live.delete('app|/save');
    await expect(
      desktop.clickElement('local', 'r2', 'left', 1, []),
    ).rejects.toThrow('r2 is stale or unknown');
    await expect(desktop.accessibilityTree({ ref: 'r2' })).rejects.toThrow(
      'r2 is stale or unknown',
    );
    expect(authorize).not.toHaveBeenCalled();

    authorize.mockImplementation(() => {
      throw new DesktopInputDeniedError('A person is using the desktop');
    });
    await expect(
      desktop.clickElement('local', 'r1', 'left', 1, []),
    ).rejects.toThrow(DesktopInputDeniedError);
    expect(authorize).toHaveBeenCalledWith({
      action: 'click',
      principalId: 'local',
    });
    expect(backend.calls.filter(([name]) => name === 'click')).toEqual([]);
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

  it('shares a slow probe and starts its cache period when it settles', async () => {
    let now = 0;
    let settle!: () => void;
    const provider = fakeProvider();
    const probe = vi.fn<DesktopProvider['probe']>(
      () =>
        new Promise((resolve) => {
          settle = () => resolve(NO_DESKTOP);
        }),
    );
    provider.probe = probe;
    const desktop = new DesktopService(provider, { now: () => now });

    const first = desktop.capabilities();
    now = 15_000;
    const second = desktop.capabilities();
    expect(probe).toHaveBeenCalledTimes(1);
    settle();
    expect(await first).toEqual(await second);
    now = 20_000;
    await desktop.capabilities();
    expect(probe).toHaveBeenCalledTimes(1);
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
    tools?: {
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }[];
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

  it('offers the accessibility tree and clicks by ref only when reported', async () => {
    const plain = createMachineMcp(cwd, {
      omitHostDetails: true,
      desktop: new DesktopService(fakeProvider()),
    });
    try {
      const { tools } = await rpc(plain, 'tools/list');
      const init = await rpc(plain, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(tools?.map(({ name }) => name)).not.toContain(
        'desktop_accessibility_tree',
      );
      expect(
        tools?.find(({ name }) => name === 'desktop_click')?.inputSchema
          ?.properties,
      ).not.toHaveProperty('ref');
      expect(init?.instructions).not.toContain('desktop_accessibility_tree');
    } finally {
      await plain.close();
    }

    const backend = accessibleProvider();
    mcp = createMachineMcp(cwd, {
      principalId: 'agent-1',
      omitHostDetails: true,
      desktop: new DesktopService(backend),
    });
    const { tools } = await rpc(mcp, 'tools/list');
    const init = await rpc(mcp, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(tools?.map(({ name }) => name)).toContain(
      'desktop_accessibility_tree',
    );
    expect(
      tools?.find(({ name }) => name === 'desktop_click')?.inputSchema
        ?.properties,
    ).toHaveProperty('ref');
    expect(init?.instructions).toContain('desktop_accessibility_tree');

    const tree = await rpc(mcp, 'tools/call', {
      name: 'desktop_accessibility_tree',
      arguments: {},
    });
    expect(tree.content?.[0]?.text).toContain('r2 push button "Save"');

    const click = await rpc(mcp, 'tools/call', {
      name: 'desktop_click',
      arguments: { ref: 'r2' },
    });
    expect(JSON.parse(click.content?.[0]?.text ?? '')).toEqual({
      ref: 'r2',
      x: 140,
      y: 65,
    });
    expect(backend.calls).toContainEqual([
      'click',
      { x: 280, y: 130 },
      'left',
      1,
      [],
    ]);

    for (const args of [{ ref: 'r2', x: 1, y: 1 }, { x: 1 }, {}]) {
      const invalid = await rpc(mcp, 'tools/call', {
        name: 'desktop_click',
        arguments: args,
      });
      expect(invalid.isError).toBe(true);
    }
    const byPoint = await rpc(mcp, 'tools/call', {
      name: 'desktop_click',
      arguments: { x: 10, y: 10 },
    });
    expect(byPoint.isError).toBeFalsy();
  });
});
