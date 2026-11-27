import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeCloud } from '../src/cloud.js';
import { decodePng, RfbViewer } from '../src/desktop.js';
import {
  contractDir,
  type Machine,
  spawnCli,
  startMachine,
  type ToolResult,
  temporaryDirectory,
  waitFor,
} from '../src/harness.js';

// Runs both servers against a real Xvnc, which serves the X display and the
// VNC Unix socket as on Klex Cloud machines. It needs Xvnc, xsetroot and xev,
// plus xdotool and ImageMagick for the TypeScript server, so it runs only
// where KLEX_MACHINE_X11 is set.
const enabled =
  process.platform === 'linux' && process.env.KLEX_MACHINE_X11 === '1';

const SCREEN = { width: 1024, height: 768 };
const BACKGROUND = 0x336699;
const XEV = { x: 100, y: 120, width: 400, height: 300 };

const desktop = JSON.parse(
  readFileSync(join(contractDir, 'desktop.json'), 'utf8'),
) as { tools: { name: string }[] };
const localTools = JSON.parse(
  readFileSync(join(contractDir, 'tools/local.json'), 'utf8'),
) as { name: string }[];

const run = promisify(execFile);

interface Xvnc {
  display: string;
  socket: string;
  env: NodeJS.ProcessEnv;
  process: ChildProcess;
}

async function startXvnc(): Promise<Xvnc> {
  const directory = await temporaryDirectory('klex xvnc ', true);
  const socket = join(directory, 'vnc.sock');
  let number = 40 + Math.floor(Math.random() * 400);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const display = `:${number}`;
  const child = spawn(
    'Xvnc',
    [
      display,
      '-geometry',
      `${SCREEN.width}x${SCREEN.height}`,
      '-depth',
      '24',
      '-rfbport',
      '-1',
      '-rfbunixpath',
      socket,
      '-SecurityTypes',
      'None',
      '-AlwaysShared',
      '-nolisten',
      'tcp',
    ],
    { stdio: 'ignore' },
  );
  const env = {
    DISPLAY: display,
    KLEX_MACHINE_DESKTOP: '',
    KLEX_MACHINE_VNC_SOCKET: socket,
    AT_SPI_BUS_ADDRESS: '',
    DBUS_SESSION_BUS_ADDRESS: '',
  };
  await waitFor(
    () =>
      existsSync(socket) && existsSync(`/tmp/.X11-unix/X${number}`)
        ? true
        : undefined,
    { timeout: 15_000 },
  );
  await run(
    'xsetroot',
    ['-solid', `#${BACKGROUND.toString(16).padStart(6, '0')}`],
    { env: { ...process.env, DISPLAY: display } },
  );
  return { display, socket, env, process: child };
}

interface ImageResult {
  content: (
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'text'; text: string }
  )[];
  isError?: boolean;
}

async function screenshot(machine: Machine) {
  const { result } = await machine.rpc<ImageResult>('tools/call', {
    name: 'desktop_screenshot',
    arguments: { format: 'png' },
  });
  expect(result?.isError).toBeFalsy();
  const image = result!.content.find((item) => item.type === 'image');
  if (image?.type !== 'image') throw new Error(JSON.stringify(result));
  return decodePng(Buffer.from(image.data, 'base64'));
}

async function act(machine: Machine, name: string, args = {}) {
  const { result, error } = await machine.call(name, args);
  expect(error).toBeUndefined();
  expect(result?.isError, JSON.stringify(result)).toBeFalsy();
  return result as ToolResult;
}

describe.skipIf(!enabled)('X11 desktop', () => {
  let xvnc: Xvnc;

  beforeAll(async () => {
    xvnc = await startXvnc();
  });
  afterAll(() => {
    xvnc?.process.kill('SIGKILL');
  });

  it('offers the desktop tools on an X display, and none when turned off', async () => {
    const machine = await startMachine({ env: xvnc.env });
    const { result } = await machine.rpc<{ tools: { name: string }[] }>(
      'tools/list',
    );
    expect(result?.tools.map((tool) => tool.name)).toEqual([
      ...desktop.tools.map((tool) => tool.name),
      ...localTools.map((tool) => tool.name),
    ]);

    const off = await startMachine({
      env: { ...xvnc.env, KLEX_MACHINE_DESKTOP: 'off' },
    });
    const { result: offTools } = await off.rpc<{ tools: { name: string }[] }>(
      'tools/list',
    );
    expect(offTools?.tools.map((tool) => tool.name)).toEqual(
      localTools.map((tool) => tool.name),
    );
  });

  it('captures the screen and drives real X input', async () => {
    const machine = await startMachine({ env: xvnc.env });
    const shot = await screenshot(machine);
    expect({ width: shot.width, height: shot.height }).toEqual(SCREEN);
    expect(shot.pixel(5, 5)).toBe(BACKGROUND);

    const log = join(await temporaryDirectory('klex xev '), 'xev.log');
    const geometry = `${XEV.width}x${XEV.height}+${XEV.x}+${XEV.y}`;
    await act(machine, 'desktop_launch', {
      command: 'sh',
      args: ['-c', `exec xev -geometry ${geometry} > '${log}'`],
    });
    const window = await waitFor(async () => {
      const { result } = await machine.call('desktop_list_windows');
      const windows = JSON.parse(result?.content[0]?.text ?? '[]') as {
        id: string;
        title: string;
        bounds: Record<string, number>;
      }[];
      return windows.find((candidate) => candidate.title === 'Event Tester');
    });
    expect(window.bounds).toEqual(XEV);
    await act(machine, 'desktop_focus_window', { id: window.id });

    const inside = (await screenshot(machine)).pixel(XEV.x + 50, XEV.y + 50);
    expect(inside).not.toBe(BACKGROUND);

    const point = { x: XEV.x + 200, y: XEV.y + 150 };
    await act(machine, 'desktop_move', point);
    await act(machine, 'desktop_click', { ...point, button: 'right' });
    await act(machine, 'desktop_scroll', {
      ...point,
      direction: 'down',
      amount: 2,
    });
    await act(machine, 'desktop_type', { text: 'aBé' });
    await act(machine, 'desktop_key', { keys: ['ctrl+Return'] });

    const count = (text: string, keysym: string) =>
      text.split(keysym).length - 1;
    const events = await waitFor(async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return count(text, 'keysym 0xff0d, Return') === 2 &&
        count(text, 'keysym 0xffe3, Control_L') === 2
        ? text
        : undefined;
    });
    const presses = events
      .split('\n\n')
      .filter((event) => /^(ButtonPress|KeyPress)/.test(event.trim()));
    const summary = presses.map((event) => {
      const button = /button (\d+)/.exec(event)?.[1];
      const keysym = /keysym 0x[0-9a-f]+, (\w+)/.exec(event)?.[1];
      const state = /state (0x[0-9a-f]+)/.exec(event)?.[1];
      const at = /root:\((\d+),(\d+)\)/.exec(event);
      return button
        ? `button ${button} at ${at?.[1]},${at?.[2]}`
        : `${keysym} ${state}`;
    });
    expect(summary).toEqual([
      `button 3 at ${point.x},${point.y}`,
      `button 5 at ${point.x},${point.y}`,
      `button 5 at ${point.x},${point.y}`,
      'a 0x0',
      'Shift_L 0x0',
      'B 0x1',
      'eacute 0x0',
      'Control_L 0x0',
      'Return 0x4',
    ]);
  });

  it('streams the display from the VNC socket in cloud mode', async () => {
    const cloud = await startFakeCloud(await temporaryDirectory());
    try {
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
        { env: { NODE_EXTRA_CA_CERTS: cloud.caFile, ...xvnc.env } },
      );
      await machine.stdoutContains('is live');
      const control = await cloud.desktop.control('machine-1');
      expect(await control.next('hello')).toMatchObject({
        type: 'hello',
        screen: SCREEN,
        capabilities: ['stream', 'lease', 'rfb-input-filter'],
      });
      const streamId = crypto.randomUUID();
      control.send({ type: 'stream.open', streamId });
      const stream = await cloud.desktop.stream(streamId);
      const viewer = new RfbViewer(stream.received, (data) =>
        stream.socket.send(data),
      );
      await viewer.handshake();
      expect({ width: viewer.width, height: viewer.height }).toEqual(SCREEN);
      viewer.requestUpdate(false);
      await viewer.update();
      expect(viewer.pixels[5 * SCREEN.width + 5]).toBe(BACKGROUND);
    } finally {
      await cloud.close();
    }
  });
});
