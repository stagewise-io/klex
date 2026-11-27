import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type DesktopControl,
  type FakeCloud,
  startFakeCloud,
} from '../src/cloud.js';
import {
  decodePng,
  FAKE_HINT,
  FAKE_SCREEN,
  fakeCapture,
  fakePixel,
  mismatches,
  RfbViewer,
} from '../src/desktop.js';
import {
  contractDir,
  type JsonRpcError,
  type Machine,
  PROTOCOL,
  PUSH,
  spawnCli,
  startMachine,
  type ToolResult,
  temporaryDirectory,
  waitFor,
} from '../src/harness.js';

const readContract = <T>(name: string): T =>
  JSON.parse(readFileSync(join(contractDir, name), 'utf8')) as T;

const localTools = readContract<unknown[]>('tools/local.json');
const pushTools = readContract<unknown[]>('tools/push.json');
const server = readContract<{
  capabilities: Record<string, unknown>;
  instructions: string;
  pushInstructionsSuffix: string;
}>('server.json');
const desktop = readContract<{
  capabilities: Record<string, unknown>;
  instructions: {
    available: string;
    accessibility: string;
    unavailable: string;
  };
  resources: unknown[];
  tools: unknown[];
  accessibilityTools: unknown[];
}>('desktop.json');
const validation = readContract<
  {
    desktop: 'fake' | 'fake-basic';
    name: string;
    push: boolean;
    arguments: Record<string, unknown>;
    result?: ToolResult;
    error?: JsonRpcError;
  }[]
>('desktop-validation.json');

type Mode = 'fake' | 'fake-basic' | 'fake-unavailable';

interface ImageResult {
  content: (
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'text'; text: string }
  )[];
  isError?: boolean;
}

async function startDesktop(mode: Mode) {
  const log = join(
    await temporaryDirectory('klex desktop log '),
    'calls.jsonl',
  );
  const machine = await startMachine({
    env: { KLEX_MACHINE_DESKTOP: mode, KLEX_MACHINE_DESKTOP_FAKE_LOG: log },
  });
  return {
    machine,
    calls: async (): Promise<Record<string, unknown>[]> => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

const baseInstructions = (machine: Machine) =>
  server.instructions
    .replace('${cwd}', machine.cwd)
    .replace('${platform}', process.platform);

async function image(machine: Machine, name: string, args = {}) {
  const { result, error } = await machine.rpc<ImageResult>('tools/call', {
    name,
    arguments: args,
  });
  if (error) throw new Error(JSON.stringify(error));
  if (result?.isError) throw new Error(JSON.stringify(result));
  const images = result!.content.filter((item) => item.type === 'image');
  const texts = result!.content.filter((item) => item.type === 'text');
  if (images.length !== 1 || texts.length === 0)
    throw new Error(`Unexpected content: ${JSON.stringify(result)}`);
  return {
    order: result!.content.map((item) => item.type),
    mimeType: images[0]!.mimeType,
    image: decodePng(Buffer.from(images[0]!.data, 'base64')),
    info: JSON.parse(texts[0]!.text) as Record<string, unknown>,
    texts: texts.map((item) => JSON.parse(item.text) as unknown),
  };
}

describe('desktop tools', () => {
  it('lists desktop tools ahead of the base tools for each fake desktop', async () => {
    const lists: Record<Mode, unknown[]> = {
      'fake-basic': desktop.tools,
      fake: desktop.accessibilityTools,
      'fake-unavailable': [],
    };
    for (const mode of Object.keys(lists) as Mode[]) {
      const { machine } = await startDesktop(mode);
      const local = await machine.rpc<{ tools: unknown[] }>('tools/list');
      expect(local.result?.tools).toEqual([...lists[mode], ...localTools]);
      const push = await machine.rpc<{ tools: unknown[] }>(
        'tools/list',
        {},
        { push: true },
      );
      expect(push.result?.tools).toEqual([...lists[mode], ...pushTools]);
    }
  });

  it('describes the desktop in capabilities and instructions', async () => {
    const expected: Record<Mode, string> = {
      'fake-basic': desktop.instructions.available,
      fake: desktop.instructions.available + desktop.instructions.accessibility,
      'fake-unavailable': desktop.instructions.unavailable.replace(
        '${hint}',
        FAKE_HINT,
      ),
    };
    for (const mode of Object.keys(expected) as Mode[]) {
      const { machine } = await startDesktop(mode);
      const plain =
        await machine.rpc<Record<string, unknown>>('server/discover');
      expect(plain.result?.instructions).toBe(
        baseInstructions(machine) + expected[mode],
      );
      expect(plain.result?.capabilities).toEqual(
        mode === 'fake-unavailable'
          ? server.capabilities
          : desktop.capabilities,
      );
      const push = await machine.rpc<Record<string, unknown>>(
        'server/discover',
        {},
        { push: true },
      );
      expect(push.result?.instructions).toBe(
        baseInstructions(machine) +
          expected[mode] +
          server.pushInstructionsSuffix,
      );
    }
  });

  it('validates desktop tool arguments like the contract', async () => {
    const machines = {
      fake: (await startDesktop('fake')).machine,
      'fake-basic': (await startDesktop('fake-basic')).machine,
    };
    for (const item of validation) {
      const response = await machines[item.desktop].rpc(
        'tools/call',
        { name: item.name, arguments: item.arguments },
        { push: item.push },
      );
      const label = `${item.desktop} ${item.name} ${JSON.stringify(item.arguments)}`;
      if (item.error) expect(response.error, label).toEqual(item.error);
      else expect(response.result, label).toEqual(item.result);
    }
  });

  it('takes scaled screenshots and zooms', async () => {
    const { machine, calls } = await startDesktop('fake-basic');
    const shot = await image(machine, 'desktop_screenshot', { format: 'png' });
    expect(shot.mimeType).toBe('image/png');
    expect(shot.info).toEqual({
      width: 1280,
      height: 800,
      screen: FAKE_SCREEN,
    });
    expect(shot.order).toEqual(['image', 'text']);
    expect([shot.image.width, shot.image.height]).toEqual([1280, 800]);
    expect(
      mismatches(
        shot.image,
        fakeCapture(
          { x: 0, y: 0, ...FAKE_SCREEN },
          { width: 1280, height: 800 },
        ),
      ),
    ).toEqual([]);

    const zoom = await image(machine, 'desktop_zoom', {
      x: 100,
      y: 80,
      width: 40,
      height: 30,
      format: 'png',
    });
    expect(zoom.info).toMatchObject({ width: zoom.image.width });
    expect(
      mismatches(
        zoom.image,
        fakeCapture(
          { x: 125, y: 100, width: 50, height: 38 },
          { width: zoom.image.width, height: zoom.image.height },
        ),
      ),
    ).toEqual([]);

    const jpeg = await machine.rpc<ImageResult>('tools/call', {
      name: 'desktop_screenshot',
      arguments: {},
    });
    expect(jpeg.result?.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
    });
    expect(await calls()).toEqual([
      {
        call: 'capture',
        region: null,
        size: { width: 1280, height: 800 },
        format: 'png',
      },
      {
        call: 'capture',
        region: { x: 125, y: 100, width: 50, height: 38 },
        size: { width: zoom.info.width, height: zoom.info.height },
        format: 'png',
      },
      {
        call: 'capture',
        region: null,
        size: { width: 1280, height: 800 },
        format: 'jpeg',
      },
    ]);
  });

  it('maps input from screenshot coordinates to the screen', async () => {
    const { machine, calls } = await startDesktop('fake-basic');
    const ok = async (name: string, args: Record<string, unknown>) => {
      const { result, error } = await machine.call(name, args);
      expect(error).toBeUndefined();
      expect(result?.isError, JSON.stringify(result)).toBeFalsy();
      return result!;
    };
    await ok('desktop_click', {
      x: 100,
      y: 200,
      button: 'right',
      count: 2,
      modifiers: ['shift'],
    });
    await ok('desktop_drag', { from: { x: 0, y: 0 }, to: { x: 1279, y: 799 } });
    await ok('desktop_move', { x: 640, y: 400 });
    await ok('desktop_scroll', { x: 10, y: 10, direction: 'down', amount: 3 });
    await ok('desktop_type', { text: 'héllo' });
    await ok('desktop_key', { keys: ['ctrl+s', 'enter'] });
    await ok('desktop_focus_window', { id: '202' });
    const launched = await ok('desktop_launch', {
      command: 'fake-app',
      args: ['--flag'],
      settleMs: 0,
    });
    const windows = await ok('desktop_list_windows', {});
    const failed = await machine.call('desktop_focus_window', { id: '999' });

    expect(await calls()).toEqual([
      {
        call: 'click',
        x: 125,
        y: 250,
        button: 'right',
        count: 2,
        modifiers: ['shift'],
      },
      {
        call: 'drag',
        from: { x: 0, y: 0 },
        to: { x: 1599, y: 999 },
        button: 'left',
      },
      { call: 'move', x: 800, y: 500 },
      { call: 'scroll', x: 13, y: 13, direction: 'down', amount: 3 },
      { call: 'type', text: 'héllo' },
      { call: 'key', keys: ['ctrl+s', 'enter'] },
      { call: 'focusWindow', id: '202' },
      {
        call: 'launch',
        command: 'fake-app',
        args: ['--flag'],
        cwd: machine.cwd,
      },
      { call: 'focusWindow', id: '999' },
    ]);
    expect(launched.content).toEqual([
      { type: 'text', text: JSON.stringify({ pid: 4242 }) },
    ]);
    expect(JSON.parse(windows.content[0]!.text)).toEqual([
      {
        id: '101',
        title: 'Fake editor',
        bounds: { x: 80, y: 40, width: 640, height: 480 },
        focused: false,
      },
      {
        id: '202',
        title: 'Fake terminal',
        bounds: { x: 720, y: 400, width: 480, height: 320 },
        focused: true,
      },
    ]);
    expect(failed.result).toEqual({
      content: [{ type: 'text', text: 'Error: No window has id 999' }],
      isError: true,
      resultType: 'complete',
    });
  });

  it('returns a screenshot after an action when asked', async () => {
    const { machine, calls } = await startDesktop('fake-basic');
    const after = await image(machine, 'desktop_move', {
      x: 1,
      y: 2,
      screenshot: true,
      settleMs: 0,
    });
    expect(after.order).toEqual(['text', 'image', 'text']);
    expect(after.texts).toEqual([
      { ok: true },
      { width: 1280, height: 800, screen: FAKE_SCREEN },
    ]);
    expect([after.image.width, after.image.height]).toEqual([1280, 800]);
    expect(await calls()).toEqual([
      { call: 'move', x: 1, y: 3 },
      {
        call: 'capture',
        region: null,
        size: { width: 1280, height: 800 },
        format: 'jpeg',
      },
    ]);
  });

  it('reads the accessibility tree and clicks elements by ref', async () => {
    const { machine, calls } = await startDesktop('fake');
    const tree = await machine.call('desktop_accessibility_tree', {});
    expect(tree.result?.isError).toBeFalsy();
    const text = tree.result!.content[0]!.text;
    expect(text).toMatchSnapshot();
    const save = /^\s*(r\d+) button "Save"/m.exec(text)?.[1];
    expect(save).toBeDefined();
    const clicked = await machine.call('desktop_click', { ref: save });
    expect(clicked.result?.isError).toBeFalsy();
    const interactive = await machine.call('desktop_accessibility_tree', {
      interactiveOnly: true,
      maxDepth: 2,
      maxNodes: 2,
    });
    expect(interactive.result!.content[0]!.text).toMatchSnapshot();
    const sub = await machine.call('desktop_accessibility_tree', {
      ref: /^\s*(r\d+) textbox/m.exec(text)?.[1],
    });
    expect(sub.result!.content[0]!.text).toMatchSnapshot();
    const gone = await machine.call('desktop_click', { ref: 'r999' });
    expect(gone.result).toMatchSnapshot();
    expect(await calls()).toEqual([
      {
        call: 'click',
        x: 160,
        y: 85,
        button: 'left',
        count: 1,
        modifiers: [],
      },
    ]);
  });

  it('serves the screen resource', async () => {
    const { machine } = await startDesktop('fake-basic');
    const listed = await machine.rpc<{ resources: unknown[] }>(
      'resources/list',
    );
    expect(listed.result?.resources).toEqual(desktop.resources);
    const templates = await machine.rpc<{ resourceTemplates: unknown[] }>(
      'resources/templates/list',
    );
    expect(templates.result?.resourceTemplates).toEqual([]);
    const read = await machine.rpc<{
      contents: { uri: string; mimeType: string; blob: string }[];
    }>(
      'resources/read',
      { uri: 'desktop://screen' },
      { headers: { 'mcp-name': 'desktop://screen' } },
    );
    expect(read.error).toBeUndefined();
    const [content] = read.result!.contents;
    expect(content).toMatchObject({
      uri: 'desktop://screen',
      mimeType: 'image/jpeg',
    });
    const missing = await machine.rpc(
      'resources/read',
      { uri: 'desktop://other' },
      { headers: { 'mcp-name': 'desktop://other' } },
    );
    expect(missing).toMatchSnapshot();
    const { machine: off } = await startDesktop('fake-unavailable');
    expect(await off.rpc('resources/list')).toMatchSnapshot();
  });
});

describe('desktop in cloud mode', () => {
  let cloud: FakeCloud;
  let log: string;

  beforeEach(async () => {
    const directory = await temporaryDirectory();
    cloud = await startFakeCloud(directory);
    log = join(directory, 'calls.jsonl');
  });
  afterEach(async () => {
    await cloud.close();
  });

  const calls = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  async function serve(): Promise<DesktopControl> {
    const machine = spawnCli(
      [
        'cloud',
        'enroll',
        cloud.issueCode(),
        '--cloud-base-url',
        cloud.baseUrl,
        '--data-dir',
        await temporaryDirectory(),
        '--cwd',
        await temporaryDirectory(),
      ],
      {
        env: {
          NODE_EXTRA_CA_CERTS: cloud.caFile,
          KLEX_MACHINE_DESKTOP: 'fake',
          KLEX_MACHINE_DESKTOP_FAKE_LOG: log,
        },
      },
    );
    await machine.stdoutContains('is live');
    return cloud.desktop.control('machine-1');
  }

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
    push = false,
  ): Promise<{ result?: T; error?: JsonRpcError }> {
    const name = params.name ?? params.uri;
    const response = await fetch(cloud.mcpUrl('machine-1'), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${await cloud.accessToken('agent-a', 'machine-1')}`,
        'mcp-method': method,
        'mcp-protocol-version': PROTOCOL,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': {
              name: 'klex-machine-conformance',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': push
              ? { extensions: { [PUSH]: {} } }
              : {},
          },
        },
      }),
    });
    return (await response.json()) as { result?: T; error?: JsonRpcError };
  }

  const click = () =>
    rpc<ToolResult>('tools/call', {
      name: 'desktop_click',
      arguments: { x: 10, y: 10 },
    });

  const controlEvents = async () =>
    (
      await rpc<{ events: Record<string, unknown>[] }>(`${PUSH}/get`, {}, true)
    ).result?.events.filter(
      (event) => event.type === 'desktop.control_changed',
    ) ?? [];

  const humanLease = (
    revision: number,
    streamId?: string,
    expiresAt = new Date(Date.now() + 600_000).toISOString(),
  ) => ({
    type: 'lease',
    revision,
    mode: 'human',
    holder: { name: 'Julian', ...(streamId ? { streamId } : {}) },
    expiresAt,
  });

  it('says hello and enforces the control lease', async () => {
    const control = await serve();
    expect(await control.next('hello')).toEqual({
      type: 'hello',
      v: 1,
      screen: FAKE_SCREEN,
      machineVersion: expect.any(String),
      capabilities: ['stream', 'lease', 'rfb-input-filter'],
    });
    expect((await click()).result?.isError).toBeFalsy();

    const human = humanLease(1);
    control.send(human);
    expect(await control.next('lease.applied')).toEqual({
      type: 'lease.applied',
      revision: 1,
    });
    expect((await click()).result).toMatchSnapshot();
    const screenshot = await rpc<ToolResult>('tools/call', {
      name: 'desktop_screenshot',
      arguments: {},
    });
    expect(screenshot.result?.isError).toBeFalsy();

    control.send(humanLease(2, undefined, '2020-01-01T00:00:00.000Z'));
    control.send({ type: 'lease', revision: 3, mode: 'agent' });
    expect(await control.next('lease.applied', 1)).toEqual({
      type: 'lease.applied',
      revision: 3,
    });
    expect(
      control.messages.filter((message) => message.type === 'lease.applied'),
    ).toHaveLength(2);
    expect((await click()).result?.isError).toBeFalsy();

    const events = await waitFor(async () => {
      const found = await controlEvents();
      return found.length >= 2 ? found : undefined;
    });
    expect(
      events.map((event) => ({
        eventId: event.eventId,
        createdAt: event.createdAt,
        content: event.content,
        data: event.data,
      })),
    ).toEqual([
      {
        eventId: expect.stringMatching(/^desktop:control:[0-9a-f-]{36}:1$/),
        createdAt: expect.any(String),
        content: [
          {
            type: 'text',
            text: 'Julian took control of the desktop. Desktop input tools are paused until control returns; screenshots still work.',
          },
        ],
        data: {
          mode: 'human',
          holder: 'Julian',
          expiresAt: human.expiresAt,
          reason: 'cloud',
        },
      },
      {
        eventId: expect.stringMatching(/:2$/),
        createdAt: expect.any(String),
        content: [
          {
            type: 'text',
            text: 'Control of the desktop returned to you. Take a fresh screenshot before acting; the screen may have changed.',
          },
        ],
        data: {
          mode: 'agent',
          holder: null,
          expiresAt: null,
          reason: 'expired',
        },
      },
    ]);
    expect(await calls()).toEqual([
      { call: 'click', x: 13, y: 13, button: 'left', count: 1, modifiers: [] },
      {
        call: 'capture',
        region: null,
        size: { width: 1280, height: 800 },
        format: 'jpeg',
      },
      { call: 'click', x: 13, y: 13, button: 'left', count: 1, modifiers: [] },
    ]);
  });

  it('relays RFB streams and forwards input only from the lease holder', async () => {
    const control = await serve();
    await control.next('hello');
    const holder = randomUUID();
    const other = randomUUID();
    control.send(humanLease(1, holder));
    await control.next('lease.applied');

    const open = async (streamId: string) => {
      control.send({ type: 'stream.open', streamId });
      const stream = await cloud.desktop.stream(streamId);
      const viewer = new RfbViewer(stream.received, (data) =>
        stream.socket.send(data),
      );
      await viewer.handshake();
      return { stream, viewer };
    };
    const first = await open(holder);
    expect(first.viewer).toMatchObject({
      width: FAKE_SCREEN.width,
      height: FAKE_SCREEN.height,
      name: 'klex-machine fake desktop',
    });
    const expected = (x: number, y: number) => fakePixel(x, y);
    const screen = {
      ...FAKE_SCREEN,
      pixel: (x: number, y: number) =>
        first.viewer.pixels[y * FAKE_SCREEN.width + x]!,
    };
    first.viewer.requestUpdate(false);
    await first.viewer.update();
    for (let round = 0; round < 20; round++) {
      if (mismatches(screen, expected, 1).length === 0) break;
      first.viewer.requestUpdate(true);
      await first.viewer.update();
    }
    expect(mismatches(screen, expected)).toEqual([]);

    const second = await open(other);
    second.viewer.pointer(1, 5, 5);
    second.viewer.pointer(0, 5, 5);
    await new Promise((done) => setTimeout(done, 300));
    first.viewer.pointer(1, 30, 40);
    first.viewer.pointer(0, 30, 40);
    first.viewer.key(true, 0x61);
    first.viewer.key(false, 0x61);
    const input = await waitFor(async () => {
      const found = (await calls()).filter((entry) =>
        String(entry.call).startsWith('stream.'),
      );
      return found.some(
        (entry) => entry.call === 'stream.key' && entry.down === false,
      )
        ? found
        : undefined;
    });
    expect(input).toMatchSnapshot();

    control.send({ type: 'stream.open', streamId: 'not-a-stream' });
    expect(await control.next('stream.failed')).toEqual({
      type: 'stream.failed',
      streamId: 'not-a-stream',
      reason: 'invalid_stream_id',
    });
    for (let index = 0; index < 2; index++) await open(randomUUID());
    const extra = randomUUID();
    control.send({ type: 'stream.open', streamId: extra });
    expect(await control.next('stream.failed', 1)).toEqual({
      type: 'stream.failed',
      streamId: extra,
      reason: 'too_many_streams',
    });

    control.send({ type: 'stream.close', streamId: other });
    expect(await second.stream.closed).toBe(1000);

    control.socket.terminate();
    expect(await first.stream.closed).toBe(1001);
    const reconnected = await waitFor(() =>
      cloud.desktop.controls.length > 1 ? cloud.desktop.controls[1] : undefined,
    );
    expect(await reconnected.next('hello')).toMatchObject({ type: 'hello' });
  });
});
