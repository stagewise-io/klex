import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { StreamHelperBackend } from '../src/desktop/platform/stream-helper.js';
import {
  keysymCodePoint,
  macosKeyToken,
  windowsKeyToken,
} from '../src/desktop/platform/stream-keys.js';
import { RfbServer } from '../src/desktop/rfb/index.js';
import { ENC, loadFrame, TestRfbClient } from './rfb-test-client.js';

const FAKE_HELPER = fileURLToPath(
  new URL('./fixtures/fake-stream-helper.mjs', import.meta.url),
);
const DESKTOP = loadFrame('desktop-260x140');

function setup(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const server = new RfbServer(
    new StreamHelperBackend({
      spawn: () => {
        const child = spawn(process.execPath, [FAKE_HELPER], {
          env: { ...process.env, ...env },
          stdio: 'pipe',
        });
        children.push(child);
        return child;
      },
      preamble: 'x'.repeat(300),
      keyToken: macosKeyToken,
      onLog: (message) => logs.push(message),
      stopTimeoutMs: 1_000,
    }),
    { name: 'fake', onError: (error) => errors.push(error.message) },
  );
  return { server, logs, errors, children };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

describe('StreamHelperBackend', { timeout: 20_000 }, () => {
  it('streams a helper frame and passes commands on', async () => {
    const { server, logs, children } = setup();
    const client = new TestRfbClient(server.open());
    await client.handshake();
    expect([client.width, client.height]).toEqual([260, 140]);
    client.setEncodings([
      ENC.tight,
      ENC.quality(5),
      ENC.qemuKey,
      ENC.clipboard,
    ]);
    client.request(false);
    const [announce] = await client.nextUpdate();
    expect(announce).toMatchObject({ encoding: ENC.qemuKey });
    client.request(false);
    await client.nextUpdate();
    expect(client.screen.every((pixel, i) => pixel === DESKTOP.pixels[i])).toBe(
      true,
    );

    client.pointer(1, 10, 20);
    client.pointer(0, 10, 20);
    client.qemuKey(true, 0xffe7, 0xdb);
    client.qemuKey(true, 0x63, 0x2e);
    client.qemuKey(false, 0x63, 0x2e);
    client.qemuKey(false, 0xffe7, 0xdb);
    await until(() => logs.length >= 8);
    expect(logs).toEqual([
      'preamble',
      'quality 77',
      'move 10 20',
      'button left 1 10 20',
      'button left 0 10 20',
      'key 1 k37',
      'key 1 k8',
      'key 0 k8',
      ...logs.slice(8),
    ]);

    client.clipboard((1 << 25) | 1);
    const provide = await client.next(
      (m) => m.type === 'clipboard' && m.text !== undefined,
    );
    expect(provide).toMatchObject({ text: 'from the fake desktop ✓' });
    client.clipboard((1 << 27) | 1);
    await client.next(
      (m) => m.type === 'clipboard' && m.flags === (1 << 25) + 1,
    );
    client.provide('hello ✓');
    await until(() => logs.some((line) => line.startsWith('clipboard ')));
    expect(logs).toContain(
      `clipboard ${Buffer.from('hello ✓').toString('base64')}`,
    );

    const [child] = children;
    client.socket.destroy();
    expect(await exited(child as ChildProcessWithoutNullStreams)).toBe(0);
    expect(server.capturing).toBe(false);
  });

  it('refuses a helper speaking another protocol version', async () => {
    const { server, errors } = setup({ FAKE_STREAM_VERSION: '2' });
    const client = new TestRfbClient(server.open());
    await expect(client.handshake()).rejects.toThrow('connection closed');
    expect(errors).toEqual([
      'The desktop stream helper sent stream protocol version 2, expected 1',
    ]);
  });

  it('closes viewers when the helper dies', async () => {
    const { server, errors } = setup({ FAKE_STREAM_EXIT: '4' });
    const client = new TestRfbClient(server.open());
    await client.handshake().catch(() => undefined);
    await until(() => client.closed);
    expect(errors).toEqual([
      'The desktop stream helper exited with code 4: fake helper failure',
    ]);
  });
});

describe('stream key tokens', () => {
  it('maps XT scan codes to macOS virtual keys', () => {
    const key = (keycode: number, keysym = 0) =>
      macosKeyToken({ down: true, keycode, keysym });
    expect(key(0x1e)).toBe('k0'); // A
    expect(key(0x2e)).toBe('k8'); // C
    expect(key(0x1d)).toBe('k3b'); // ControlLeft
    expect(key(0xdb)).toBe('k37'); // MetaLeft, Command
    expect(key(0xb8)).toBe('k3d'); // AltRight
    expect(key(0xcb)).toBe('k7b'); // ArrowLeft
    expect(key(0x56)).toBe('ka'); // IntlBackslash
    expect(key(0x9c)).toBe('k4c'); // NumpadEnter
  });

  it('falls back to keysyms on macOS', () => {
    const key = (keysym: number) =>
      macosKeyToken({ down: true, keycode: 0, keysym });
    expect(key(0x61)).toBe('k0');
    expect(key(0x41)).toBe('k0');
    expect(key(0x40)).toBe('k13'); // @ on the 2 key
    expect(key(0xff0d)).toBe('k24');
    expect(key(0xffbe)).toBe('k7a'); // F1
    expect(key(0xe9)).toBe('ue9'); // é
    expect(key(0x10020ac)).toBe('u20ac'); // €
    expect(key(0xfe50)).toBeUndefined(); // dead_grave
  });

  it('maps XT scan codes to Windows scan codes', () => {
    const key = (keycode: number, keysym = 0) =>
      windowsKeyToken({ down: true, keycode, keysym });
    expect(key(0x1e)).toBe('s1e');
    expect(key(0x9d)).toBe('e1d'); // ControlRight
    expect(key(0xdb)).toBe('e5b'); // MetaLeft
    expect(key(0xcb)).toBe('e4b'); // ArrowLeft
    expect(key(0x45)).toBe('e45'); // NumLock
    expect(key(0x54)).toBe('e37'); // PrintScreen
    expect(key(0x5d)).toBe('s64'); // F13
  });

  it('falls back to keysyms on Windows', () => {
    const key = (keysym: number) =>
      windowsKeyToken({ down: true, keycode: 0, keysym });
    expect(key(0xff0d)).toBe('vd');
    expect(key(0xffe3)).toBe('va2');
    expect(key(0xffc9)).toBe('v7b'); // F12
    expect(key(0x61)).toBe('u61');
    expect(key(0x10020ac)).toBe('u20ac');
    expect(keysymCodePoint(0xff08)).toBeUndefined();
  });
});
