import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineDeviceType } from '../src/cloud/facts/device-type.js';
import { createMachineIconProvider, machineIcons } from '../src/icons.js';

const deviceTypes: (MachineDeviceType | undefined)[] = [
  'laptop',
  'desktop',
  'server',
  'vm',
  'container',
  undefined,
];

function decode(src: string) {
  expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
  return Buffer.from(src.split(',')[1] ?? '', 'base64').toString('utf8');
}

afterEach(() => vi.useRealTimers());

describe('machine icons', () => {
  it.each(deviceTypes)(
    'advertises scalable standalone images for %s',
    (type) => {
      const icons = machineIcons(type);
      expect(icons.map(({ theme }) => theme)).toEqual(['light', 'dark']);
      for (const icon of icons) {
        expect(icon.mimeType).toBe('image/svg+xml');
        expect(icon.sizes).toEqual(['any']);
        const svg = decode(icon.src);
        expect(svg).toContain('viewBox="0 0 24 24"');
        expect(svg).toContain('stroke-width="2"');
        expect(svg).toContain(icon.theme === 'dark' ? '#eeece8' : '#383633');
        expect(svg).not.toMatch(
          /foreignObject|currentColor|https?:\/\/(?!www.w3.org)/,
        );
      }
    },
  );

  it('uses the same rack icon for virtual machines and servers', () => {
    expect(machineIcons('vm')).toEqual(machineIcons('server'));
  });

  it('keeps other device shapes distinct', () => {
    const distinctTypes: (MachineDeviceType | undefined)[] = [
      'laptop',
      'desktop',
      'server',
      'container',
      undefined,
    ];
    const sources = distinctTypes.map((type) => machineIcons(type)[0]?.src);
    expect(new Set(sources).size).toBe(5);
  });

  it('shares a lazy, single-flight probe across requests', async () => {
    const detect = vi.fn(async () => 'laptop' as const);
    const icons = createMachineIconProvider(detect);
    expect(detect).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([icons(), icons()]);
    expect(first).toEqual(machineIcons('laptop'));
    expect(second).toBe(first);
    expect(await icons()).toBe(first);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith(
      process.platform,
      expect.any(AbortSignal),
    );
  });

  it('falls back when detection fails or is unavailable', async () => {
    const unavailable = createMachineIconProvider(async () => undefined);
    const failed = createMachineIconProvider(async () => {
      throw new Error('unavailable');
    });
    expect(await unavailable()).toEqual(machineIcons());
    expect(await failed()).toEqual(machineIcons());
  });

  it('bounds slow detection to one second and aborts without retrying', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const detect = vi.fn((_platform: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise<MachineDeviceType | undefined>(() => {});
    });
    const icons = createMachineIconProvider(detect);
    const pending = icons();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(machineIcons());
    expect(signal?.aborted).toBe(true);
    expect(await icons()).toEqual(machineIcons());
    expect(detect).toHaveBeenCalledTimes(1);
  });
});
