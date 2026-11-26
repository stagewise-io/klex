import { describe, expect, it } from 'vitest';

import { RfbServer } from '../src/desktop/rfb/server.js';
import {
  ENC,
  loadFrame,
  type Rect,
  SyntheticCapture,
  TestRfbClient,
} from './rfb-test-client.js';

const CLIPBOARD_CAPS = 1 << 24;
const CLIPBOARD_REQUEST = 1 << 25;
const CLIPBOARD_NOTIFY = 1 << 27;
const CLIPBOARD_PROVIDE = 1 << 28;
const TEXT = 1;

const DESKTOP = loadFrame('desktop-260x140');
const CHANGED = loadFrame('desktop-260x140-changed');
const RESIZED = loadFrame('desktop-280x150');

function tightKinds(rects: Rect[]): Record<string, string | undefined> {
  return Object.fromEntries(
    rects
      .filter((rect) => rect.encoding === ENC.tight)
      .map((rect) => [`${rect.x},${rect.y}`, rect.tight]),
  );
}

async function connect(
  server: RfbServer,
  encodings: number[] = [ENC.tight, ENC.extendedDesktopSize, ENC.clipboard],
): Promise<TestRfbClient> {
  const client = new TestRfbClient(server.open());
  await client.handshake();
  client.setEncodings(encodings);
  return client;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('RfbServer', () => {
  it('captures only while a viewer is connected', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend(), { name: 'Test desktop' });
    expect(capture.starts).toBe(0);

    const first = new TestRfbClient(server.open());
    await first.handshake();
    expect(first.name).toBe('Test desktop');
    expect([first.width, first.height]).toEqual([260, 140]);
    const second = new TestRfbClient(server.open());
    await second.handshake('RFB 003.003\n');
    expect(capture.starts).toBe(1);

    first.socket.destroy();
    await settle();
    expect(capture.stops).toBe(0);
    second.socket.destroy();
    await settle();
    expect(capture.stops).toBe(1);
    expect(server.capturing).toBe(false);

    const third = new TestRfbClient(server.open());
    await third.handshake('RFB 003.007\n');
    expect(capture.starts).toBe(2);
    server.close();
  });

  it('sends the desktop losslessly with Tight', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight]);
    client.request(false);
    const rects = await client.nextUpdate();
    expect(tightKinds(rects)).toEqual(DESKTOP.tight);
    expect(client.screen).toEqual(DESKTOP.pixels);
    server.close();
  });

  it('falls back to Raw', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.raw]);
    client.request(false);
    const rects = await client.nextUpdate();
    expect(rects.every((rect) => rect.encoding === ENC.raw)).toBe(true);
    expect(client.screen).toEqual(DESKTOP.pixels);
    server.close();
  });

  it('sends only changed tiles to incremental requests', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight]);
    client.request(false);
    await client.nextUpdate();

    client.request(true);
    await settle();
    expect(client.messages).toHaveLength(1);
    capture.show(CHANGED);
    const rects = await client.nextUpdate();
    expect(tightKinds(rects)).toEqual(CHANGED.tight);
    expect(client.screen).toEqual(CHANGED.pixels);
    server.close();
  });

  it('lets a slow viewer skip frames', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(256, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight]);
    client.request(false);
    await client.nextUpdate();
    for (let color = 1; color <= 5; color++)
      capture.show(SyntheticCapture.solid(256, 128, color));
    client.request(true);
    const rects = await client.nextUpdate();
    expect(rects).toHaveLength(2);
    expect(client.screen.every((pixel) => pixel === 5)).toBe(true);
    server.close();
  });

  it('serves viewers that join a running capture', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const first = await connect(server, [ENC.tight]);
    first.request(false);
    await first.nextUpdate();
    const second = await connect(server, [ENC.raw]);
    second.request(false);
    await second.nextUpdate();
    expect(second.screen).toEqual(DESKTOP.pixels);
    expect(server.viewers).toBe(2);
    server.close();
  });

  it('follows a resize of the desktop', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight, ENC.extendedDesktopSize]);
    client.request(false);
    const initial = await client.nextUpdate();
    expect(initial[0]).toMatchObject({ encoding: ENC.extendedDesktopSize });
    client.request(true);
    capture.show(RESIZED);
    const rects = await client.nextUpdate();
    expect(rects[0]).toMatchObject({
      encoding: ENC.extendedDesktopSize,
      x: 0,
      y: 0,
      width: 280,
      height: 150,
    });
    expect(tightKinds(rects)).toEqual(RESIZED.tight);
    expect([client.width, client.height]).toEqual([280, 150]);
    expect(client.screen).toEqual(RESIZED.pixels);
    server.close();
  });

  it('follows a resize that lands before the viewer sets encodings', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = new TestRfbClient(server.open());
    await client.handshake();
    capture.show(RESIZED);
    await settle();
    expect(client.closed).toBe(false);
    client.setEncodings([ENC.tight, ENC.desktopSize]);
    client.request(false);
    const rects = await client.nextUpdate();
    expect(rects[0]).toMatchObject({
      encoding: ENC.desktopSize,
      width: 280,
      height: 150,
    });
    expect(client.screen).toEqual(RESIZED.pixels);

    const legacy = new TestRfbClient(server.open());
    await legacy.handshake();
    capture.show(DESKTOP);
    await settle();
    legacy.setEncodings([ENC.tight]);
    await settle();
    expect(legacy.closed).toBe(true);

    const defaults = new TestRfbClient(server.open());
    await defaults.handshake();
    defaults.request(false);
    capture.show(RESIZED);
    await settle();
    expect(defaults.closed).toBe(true);
    server.close();
  });

  it('refuses resizes requested by the viewer', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight, ENC.extendedDesktopSize]);
    client.request(false);
    await client.nextUpdate();
    const request = Buffer.alloc(24);
    request[0] = 251;
    request.writeUInt16BE(800, 2);
    request.writeUInt16BE(600, 4);
    request[6] = 1;
    client.socket.write(request);
    client.request(true);
    const rects = await client.nextUpdate();
    expect(rects[0]).toMatchObject({
      encoding: ENC.extendedDesktopSize,
      x: 1,
      y: 1,
      width: 260,
      height: 140,
    });
    server.close();
  });

  it('closes viewers that cannot follow a resize', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight]);
    client.request(false);
    await client.nextUpdate();
    capture.show(RESIZED);
    await settle();
    expect(client.closed).toBe(true);
  });

  it('passes JPEG tiles to viewers that take JPEG', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight, ENC.quality(5)]);
    client.request(false);
    await client.nextUpdate();
    expect(capture.quality).toBe(77);

    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    capture.sink?.jpeg({ x: 0, y: 0, width: 128, height: 128 }, jpeg);
    capture.sink?.frame();
    client.request(true);
    const [rect] = await client.nextUpdate();
    expect(rect?.jpeg).toEqual(jpeg);
    server.close();
  });

  it('turns JPEG off while any viewer cannot take it', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const lossy = await connect(server, [ENC.tight, ENC.quality(8)]);
    lossy.request(false);
    await lossy.nextUpdate();
    expect(capture.quality).toBe(92);
    const better = await connect(server, [ENC.tight, ENC.quality(9)]);
    better.request(false);
    await better.nextUpdate();
    expect(capture.quality).toBe(92);

    const lossless = await connect(server, [ENC.tight]);
    lossless.request(false);
    await lossless.nextUpdate();
    expect(capture.quality).toBeUndefined();
    expect(capture.refreshes).toBe(1);

    lossless.socket.destroy();
    await settle();
    expect(capture.quality).toBe(92);
    server.close();
  });

  it('passes pointer and keyboard input on and releases it on close', async () => {
    const capture = new SyntheticCapture(DESKTOP);
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.tight, ENC.qemuKey]);
    client.request(false);
    const [announce] = await client.nextUpdate();
    expect(announce).toMatchObject({ encoding: ENC.qemuKey });

    client.pointer(0, 10, 20);
    client.pointer(1, 10, 20);
    client.pointer(0, 12, 22);
    client.pointer(8, 12, 22);
    client.pointer(0, 12, 22);
    client.pointer(4, 999, 999);
    client.key(true, 0x61);
    client.key(false, 0x61);
    client.qemuKey(true, 0xffe3, 0x1d);
    client.qemuKey(true, 0x63, 0x2e);
    await settle();
    client.socket.destroy();
    await settle();
    expect(capture.input).toEqual([
      'move 10 20',
      'button left 1 10 20',
      'move 12 22',
      'button left 0 12 22',
      'wheel up 12 22',
      'move 259 139',
      'button right 1 259 139',
      'key 1 61 0',
      'key 0 61 0',
      'key 1 ffe3 29',
      'key 1 63 46',
      'key 0 ffe3 29',
      'key 0 63 46',
      'button right 0 259 139',
    ]);
  });

  it('holds input until the clipboard a viewer announced arrives', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server);
    const caps = await client.next((m) => m.type === 'clipboard');
    expect(caps).toMatchObject({ type: 'clipboard' });
    expect((caps as { flags: number }).flags & CLIPBOARD_CAPS).toBeTruthy();

    client.clipboard(CLIPBOARD_NOTIFY | TEXT);
    client.qemuKey(true, 0xffe3, 0x1d);
    client.qemuKey(true, 0x76, 0x2f);
    const request = await client.next((m) => m.type === 'clipboard');
    expect((request as { flags: number }).flags).toBe(CLIPBOARD_REQUEST | TEXT);
    await settle();
    expect(capture.input).toEqual([]);

    client.provide('Grüße\nzwei Zeilen 🎉');
    await settle();
    expect(capture.input).toEqual([
      'clipboard Grüße\nzwei Zeilen 🎉',
      'key 1 ffe3 29',
      'key 1 76 47',
    ]);
    server.close();
  });

  it('offers the desktop clipboard without pushing it', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server);
    await client.next((m) => m.type === 'clipboard');

    capture.sink?.clipboard('from the desktop\n✓');
    const notify = await client.next((m) => m.type === 'clipboard');
    expect((notify as { flags: number; text?: string }).flags).toBe(
      CLIPBOARD_NOTIFY | TEXT,
    );
    expect((notify as { text?: string }).text).toBeUndefined();

    client.clipboard(CLIPBOARD_REQUEST | TEXT);
    const provide = await client.next((m) => m.type === 'clipboard');
    expect(provide).toMatchObject({
      flags: CLIPBOARD_PROVIDE | TEXT,
      text: 'from the desktop\r\n✓',
    });

    // The desktop reporting text a viewer just set is not announced again.
    client.clipboard(CLIPBOARD_NOTIFY | TEXT);
    await client.next((m) => m.type === 'clipboard');
    client.provide('from the viewer');
    await settle();
    capture.sink?.clipboard('from the viewer');
    await settle();
    const after = client.messages.filter((m) => m.type === 'clipboard');
    expect(after).toHaveLength(4);
    server.close();
  });

  it('pushes the desktop clipboard as Latin-1 to viewers without the extension', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server, [ENC.raw]);
    capture.sink?.clipboard('Grüße\r\n✓');
    expect(await client.next((m) => m.type === 'cut')).toEqual({
      type: 'cut',
      text: 'Grüße\n?',
    });
    server.close();
  });

  it('closes viewers when the capture fails', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const errors: Error[] = [];
    const server = new RfbServer(capture.backend(), {
      onError: (error) => errors.push(error),
    });
    const client = await connect(server);
    capture.sink?.ended(new Error('helper crashed'));
    await settle();
    expect(client.closed).toBe(true);
    expect(errors.map((error) => error.message)).toEqual(['helper crashed']);
    expect(server.capturing).toBe(false);
  });

  it('fails viewers when the capture never starts', async () => {
    const server = new RfbServer(
      {
        start: () => ({
          setQuality() {},
          refresh() {},
          move() {},
          button() {},
          wheel() {},
          key() {},
          setClipboard() {},
          stop() {},
        }),
      },
      { readyTimeoutMs: 20 },
    );
    const client = new TestRfbClient(server.open());
    await expect(client.handshake()).rejects.toThrow('connection closed');
  });

  it('closes viewers that break the protocol', async () => {
    const capture = new SyntheticCapture(SyntheticCapture.solid(128, 128, 0));
    const server = new RfbServer(capture.backend());
    const client = await connect(server);
    client.socket.write(Buffer.from([99]));
    await settle();
    expect(client.closed).toBe(true);
    expect(capture.stops).toBe(1);
  });
});
