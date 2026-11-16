import type { Duplex } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DesktopProvider } from '../src/desktop/index.js';

export interface DesktopProviderFixture {
  provider: DesktopProvider;
  close?: () => Promise<void>;
}

export interface ExpectedCapabilities {
  computerUse: boolean;
  stream: boolean;
}

const RFB_VERSION = /^RFB 003\.00[378]\n$/;

/**
 * The behaviour every `DesktopProvider` must have, whatever the platform. A new
 * provider runs this once per environment it can be set up in, with the
 * capabilities that environment should report.
 */
export function describeDesktopProviderContract(
  name: string,
  expected: ExpectedCapabilities,
  setup: () => Promise<DesktopProviderFixture>,
): void {
  describe(`DesktopProvider contract: ${name}`, () => {
    let fixture: DesktopProviderFixture;

    beforeEach(async () => {
      fixture = await setup();
    });

    afterEach(async () => {
      await fixture.close?.();
    });

    it('reports its capabilities from probe() without rejecting', async () => {
      const capabilities = await fixture.provider.probe();
      expect({
        computerUse: capabilities.computerUse,
        stream: capabilities.stream,
      }).toEqual(expected);
      if (expected.computerUse || expected.stream) {
        expect(capabilities.screen).toEqual({
          width: expect.any(Number),
          height: expect.any(Number),
        });
        expect(capabilities.screen?.width).toBeGreaterThan(0);
        expect(capabilities.screen?.height).toBeGreaterThan(0);
      } else {
        expect(capabilities.screen).toBeUndefined();
      }
      expect(await fixture.provider.probe()).toEqual(capabilities);
    });

    it.runIf(expected.computerUse)(
      'captures, reports geometry and accepts input',
      async () => {
        const { provider } = fixture;
        const { screen } = await provider.probe();
        expect(await provider.screenSize()).toEqual(screen);
        for (const format of ['jpeg', 'png'] as const) {
          expect((await provider.capture({ format })).length).toBeGreaterThan(
            0,
          );
        }
        expect(
          (
            await provider.capture({
              format: 'jpeg',
              region: { x: 0, y: 0, width: 10, height: 10 },
              size: { width: 20, height: 20 },
            })
          ).length,
        ).toBeGreaterThan(0);
        await provider.move({ x: 1, y: 1 });
        await provider.click({ x: 1, y: 1 }, 'left', 1, []);
        await provider.drag({ x: 1, y: 1 }, { x: 2, y: 2 }, 'left');
        await provider.scroll({ x: 1, y: 1 }, 'down', 1);
        await provider.type('hello');
        await provider.key(['ctrl+a']);
        const windows = await provider.listWindows();
        for (const window of windows) {
          expect(window).toEqual({
            id: expect.any(String),
            title: expect.any(String),
            bounds: {
              x: expect.any(Number),
              y: expect.any(Number),
              width: expect.any(Number),
              height: expect.any(Number),
            },
            focused: expect.any(Boolean),
          });
        }
        if (windows[0]) await provider.focusWindow(windows[0].id);
        const { pid } = await provider.launch({ command: 'true', args: [] });
        expect(pid).toBeGreaterThan(0);
      },
    );

    it.runIf(expected.stream)(
      'opens independent RFB sources for concurrent viewers',
      async () => {
        const streams = await Promise.all([
          fixture.provider.openStream(),
          fixture.provider.openStream(),
        ]);
        try {
          for (const stream of streams) {
            expect((await firstBytes(stream, 12)).toString('latin1')).toMatch(
              RFB_VERSION,
            );
          }
        } finally {
          for (const stream of streams) stream.destroy();
        }
      },
    );

    it.runIf(!expected.stream)('rejects openStream()', async () => {
      await expect(fixture.provider.openStream()).rejects.toThrow();
    });
  });
}

function firstBytes(stream: Duplex, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length >= length) {
        stream.off('data', onData);
        resolve(data.subarray(0, length));
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
    stream.once('close', () => reject(new Error('Stream closed early')));
  });
}
