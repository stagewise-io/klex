import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeCloud } from '../src/cloud.js';
import { decodePng, RfbViewer } from '../src/desktop.js';
import {
  contractDir,
  implementation,
  type Machine,
  spawnCli,
  startMachine,
  type ToolResult,
  temporaryDirectory,
  waitFor,
} from '../src/harness.js';

// Runs the Rust server's Wayland desktop against a real PipeWire daemon and
// a scripted xdg-desktop-portal (fixtures/fake-portal.py) on a private
// session bus. A GStreamer test source stands in for the compositor's
// screen cast. It needs pipewire, wireplumber, pw-dump, gst-launch-1.0 with
// the PipeWire plugin, dbus-daemon and python3-dbus, so it runs only where
// KLEX_MACHINE_WAYLAND is set.
const enabled =
  process.platform === 'linux' &&
  process.env.KLEX_MACHINE_WAYLAND === '1' &&
  implementation === 'rust';

const FRAME = { width: 320, height: 200 };
/** The portal's logical stream size, as KDE reports on a 2x screen. */
const LOGICAL = { width: 160, height: 100 };
const COLOR = 0x336699;
const NODE_NAME = 'klex-test-screen';
const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';

const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const CONTROL_L = 0xffe3;
const RETURN = 0xff0d;

const desktop = JSON.parse(
  readFileSync(join(contractDir, 'desktop.json'), 'utf8'),
) as { tools: { name: string }[] };
const localTools = JSON.parse(
  readFileSync(join(contractDir, 'tools/local.json'), 'utf8'),
) as { name: string }[];

const run = promisify(execFile);
const fakePortal = fileURLToPath(
  new URL('../fixtures/fake-portal.py', import.meta.url),
);

interface Session {
  env: NodeJS.ProcessEnv;
  log: string;
  processes: ChildProcess[];
}

function background(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  output: string[],
): ChildProcess {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (data: Buffer) => output.push(data.toString()));
  child.stderr!.on('data', (data: Buffer) => output.push(data.toString()));
  return child;
}

async function startSession(): Promise<Session> {
  const directory = await temporaryDirectory('klex-wayland-', true);
  const runtime = join(directory, 'run');
  await run('mkdir', ['-p', runtime]);
  await chmod(runtime, 0o700);
  const output: string[] = [];
  const processes: ChildProcess[] = [];
  const bus = `unix:path=${join(runtime, 'bus')}`;
  processes.push(
    background(
      'dbus-daemon',
      ['--session', '--nofork', '--nopidfile', `--address=${bus}`],
      {},
      output,
    ),
  );
  const env = {
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: bus,
  };
  await waitFor(
    async () =>
      await run('dbus-send', [
        `--bus=${bus}`,
        '--dest=org.freedesktop.DBus',
        '/',
        'org.freedesktop.DBus.Peer.Ping',
      ]).then(
        () => true,
        () => undefined,
      ),
    { timeout: 10_000, interval: 100 },
  );
  processes.push(background('pipewire', [], env, output));
  await waitFor(
    async () =>
      await run('pw-dump', [], { env: { ...process.env, ...env } }).then(
        () => true,
        () => undefined,
      ),
    { timeout: 10_000, interval: 100 },
  );
  processes.push(background('wireplumber', [], env, output));
  const color = `0xff${COLOR.toString(16).padStart(6, '0')}`;
  processes.push(
    background(
      'gst-launch-1.0',
      [
        '-q',
        'videotestsrc',
        'pattern=solid-color',
        `foreground-color=${color}`,
        'is-live=true',
        '!',
        `video/x-raw,format=BGRx,width=${FRAME.width},height=${FRAME.height},framerate=30/1`,
        '!',
        'pipewiresink',
        'mode=provide',
        `stream-properties=props,node.name=${NODE_NAME},media.class=Video/Source`,
      ],
      env,
      output,
    ),
  );
  const log = join(directory, 'portal.log');
  const portal = background(
    'python3',
    [
      fakePortal,
      '--log',
      log,
      '--node-name',
      NODE_NAME,
      '--size',
      `${LOGICAL.width}x${LOGICAL.height}`,
    ],
    env,
    output,
  );
  processes.push(portal);
  await waitFor(() => (output.join('').includes('ready') ? true : undefined), {
    timeout: 15_000,
  }).catch((error: unknown) => {
    throw new Error(`The fake portal did not start:\n${output.join('')}`, {
      cause: error,
    });
  });
  return {
    env: {
      ...env,
      WAYLAND_DISPLAY: 'wayland-klex-test',
      XDG_SESSION_TYPE: 'wayland',
      DISPLAY: '',
      KLEX_MACHINE_DESKTOP: '',
      KLEX_MACHINE_VNC_SOCKET: '',
      AT_SPI_BUS_ADDRESS: '',
    },
    log,
    processes,
  };
}

interface PortalCall {
  call: string;
  options?: Record<string, unknown>;
  values?: number[];
}

async function portalCalls(session: Session): Promise<PortalCall[]> {
  const text = await readFile(session.log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PortalCall);
}

/** Notify calls since `from`, without the stream id of pointer motion. */
async function input(session: Session, from: number): Promise<string[]> {
  return (await portalCalls(session))
    .slice(from)
    .filter((entry) => entry.call.startsWith('Notify'))
    .map((entry) => {
      const values =
        entry.call === 'NotifyPointerMotionAbsolute'
          ? entry.values!.slice(1)
          : entry.values!;
      return `${entry.call.replace('Notify', '')} ${values.join(' ')}`;
    });
}

async function portal(session: Session, method: string, ...args: string[]) {
  await run('dbus-send', [
    `--bus=${session.env.DBUS_SESSION_BUS_ADDRESS}`,
    '--type=method_call',
    '--print-reply',
    `--dest=${PORTAL}`,
    PORTAL_PATH,
    `org.klex.FakePortal.${method}`,
    ...args,
  ]);
}

async function instructions(machine: Machine): Promise<string> {
  const { result } = await machine.rpc<{ instructions: string }>(
    'server/discover',
  );
  return result!.instructions;
}

async function listed(machine: Machine): Promise<string[]> {
  const { result } = await machine.rpc<{ tools: { name: string }[] }>(
    'tools/list',
  );
  return result!.tools.map((tool) => tool.name);
}

/** Waits for the portal session, which a probe starts in the background. */
async function ready(machine: Machine) {
  const all = [...desktop.tools, ...localTools].map((tool) => tool.name);
  await waitFor(
    async () =>
      JSON.stringify(await listed(machine)) === JSON.stringify(all)
        ? true
        : undefined,
    { timeout: 30_000, interval: 500 },
  );
}

async function act(machine: Machine, name: string, args = {}) {
  const { result, error } = await machine.call(name, args);
  expect(error).toBeUndefined();
  expect(result?.isError, JSON.stringify(result)).toBeFalsy();
  return result as ToolResult;
}

describe.skipIf(!enabled)('Wayland desktop through the portal', () => {
  let session: Session;

  beforeAll(async () => {
    session = await startSession();
  }, 60_000);
  afterAll(() => {
    for (const child of session?.processes ?? []) child.kill('SIGKILL');
  });

  it('starts sharing in the background, then captures and drives input', async () => {
    const dataDir = await temporaryDirectory('klex wayland data ');
    const machine = await startMachine({ env: session.env, dataDir });
    await ready(machine);
    expect(await instructions(machine)).toContain('desktop');

    const { result } = await machine.rpc<{
      content: { type: string; data: string }[];
    }>('tools/call', {
      name: 'desktop_screenshot',
      arguments: { format: 'png' },
    });
    const image = result!.content.find((item) => item.type === 'image')!;
    const shot = decodePng(Buffer.from(image.data, 'base64'));
    expect({ width: shot.width, height: shot.height }).toEqual(FRAME);
    expect(shot.pixel(5, 5)).toBe(COLOR);
    expect(shot.pixel(FRAME.width - 5, FRAME.height - 5)).toBe(COLOR);

    const from = (await portalCalls(session)).length;
    const point = { x: 100, y: 50 };
    const logical = `${point.x / 2} ${point.y / 2}`;
    await act(machine, 'desktop_move', point);
    await act(machine, 'desktop_click', { ...point, button: 'right' });
    await act(machine, 'desktop_click', {
      ...point,
      button: 'left',
      modifiers: ['ctrl'],
    });
    await act(machine, 'desktop_scroll', {
      ...point,
      direction: 'down',
      amount: 2,
    });
    await act(machine, 'desktop_type', { text: 'aB' });
    await act(machine, 'desktop_key', { keys: ['ctrl+Return'] });
    expect(await input(session, from)).toEqual([
      `PointerMotionAbsolute ${logical}`,
      `PointerMotionAbsolute ${logical}`,
      `PointerButton ${BTN_RIGHT} 1`,
      `PointerButton ${BTN_RIGHT} 0`,
      `KeyboardKeysym ${CONTROL_L} 1`,
      `PointerMotionAbsolute ${logical}`,
      `PointerButton ${BTN_LEFT} 1`,
      `PointerButton ${BTN_LEFT} 0`,
      `KeyboardKeysym ${CONTROL_L} 0`,
      `PointerMotionAbsolute ${logical}`,
      'PointerAxisDiscrete 0 1',
      'PointerAxisDiscrete 0 1',
      'KeyboardKeysym 97 1',
      'KeyboardKeysym 97 0',
      'KeyboardKeysym 66 1',
      'KeyboardKeysym 66 0',
      `KeyboardKeysym ${CONTROL_L} 1`,
      `KeyboardKeysym ${RETURN} 1`,
      `KeyboardKeysym ${RETURN} 0`,
      `KeyboardKeysym ${CONTROL_L} 0`,
    ]);
    const windows = await machine.call('desktop_list_windows');
    expect(windows.result?.isError).toBe(true);

    // The restore token is kept, and the next run hands it back.
    const tokenFile = join(dataDir, 'desktop-portal-token');
    const first = (await readFile(tokenFile, 'utf8')).trim();
    expect(first).toMatch(/^token-\d+$/);
    await machine.stop('SIGTERM');
    const before = (await portalCalls(session)).length;
    const again = await startMachine({ env: session.env, dataDir });
    await ready(again);
    const select = (await portalCalls(session))
      .slice(before)
      .find((entry) => entry.call === 'SelectDevices');
    expect(select?.options).toMatchObject({
      persist_mode: 2,
      restore_token: first,
      types: 3,
    });
    expect((await readFile(tokenFile, 'utf8')).trim()).not.toBe(first);

    // Stopping the share from the desktop is reported until restart.
    await portal(session, 'CloseSessions');
    const stopped = await waitFor(
      async () => {
        const { result } = await again.call('desktop_screenshot');
        return result?.isError ? result : undefined;
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(JSON.stringify(stopped)).toContain('stopped');
  }, 90_000);

  it('explains a declined dialog', async () => {
    await portal(session, 'SetDeny', 'boolean:true');
    try {
      const machine = await startMachine({ env: session.env });
      const hint = await waitFor(
        async () => {
          const text = await instructions(machine);
          return text.includes('declined') ? text : undefined;
        },
        { timeout: 30_000, interval: 500 },
      );
      expect(hint).toContain('Restart klex-machine');
      expect(await listed(machine)).toEqual(
        localTools.map((tool) => tool.name),
      );
    } finally {
      await portal(session, 'SetDeny', 'boolean:false');
    }
  }, 60_000);

  it('streams the screen and forwards viewer input in cloud mode', async () => {
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
        { env: { NODE_EXTRA_CA_CERTS: cloud.caFile, ...session.env } },
      );
      await machine.stdoutContains('is live');
      const control = await cloud.desktop.control('machine-1');
      // The first hello can predate the portal session.
      const hello = await waitFor(
        () =>
          control.messages.find(
            (message) =>
              message.type === 'hello' &&
              JSON.stringify(message.screen) === JSON.stringify(FRAME),
          ),
        { timeout: 40_000, interval: 200 },
      );
      expect(hello).toMatchObject({
        capabilities: ['stream', 'lease', 'rfb-input-filter'],
      });
      const streamId = crypto.randomUUID();
      control.send({
        type: 'lease',
        revision: 1,
        mode: 'human',
        holder: { name: 'Julian', streamId },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      await control.next('lease.applied');
      control.send({ type: 'stream.open', streamId });
      const stream = await cloud.desktop.stream(streamId);
      const viewer = new RfbViewer(stream.received, (data) =>
        stream.socket.send(data),
      );
      await viewer.handshake();
      expect({ width: viewer.width, height: viewer.height }).toEqual(FRAME);
      viewer.requestUpdate(false);
      await viewer.update();
      expect(viewer.pixels[5 * FRAME.width + 5]).toBe(COLOR);

      const from = (await portalCalls(session)).length;
      viewer.pointer(1, 40, 20);
      viewer.pointer(0, 40, 20);
      const events = await waitFor(
        async () => {
          const found = await input(session, from);
          return found.includes(`PointerButton ${BTN_LEFT} 0`)
            ? found
            : undefined;
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(events).toContain('PointerMotionAbsolute 20 10');
      expect(events).toContain(`PointerButton ${BTN_LEFT} 1`);
    } finally {
      await cloud.close();
    }
  }, 90_000);
});
