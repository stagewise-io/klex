import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodePng } from '../src/desktop.js';
import { contractDir, type Machine, startMachine } from '../src/harness.js';

/**
 * The real macOS desktop. Whether computer use is on depends on the TCC
 * grants of whatever started the test run, so without them only the hint
 * is checked.
 */
const readContract = <T>(name: string): T =>
  JSON.parse(readFileSync(join(contractDir, name), 'utf8')) as T;

const localTools = readContract<unknown[]>('tools/local.json');
const desktop = readContract<{
  instructions: { available: string; unavailable: string };
  tools: unknown[];
}>('desktop.json');

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

async function startNative() {
  const machine = await startMachine({ env: { KLEX_MACHINE_DESKTOP: '' } });
  const listed = await machine.rpc<{ tools: { name: string }[] }>('tools/list');
  const available = listed.result!.tools.some(
    (tool) => tool.name === 'desktop_screenshot',
  );
  return { machine, listed: listed.result!.tools, available };
}

async function call(machine: Machine, name: string, args = {}) {
  const { result, error } = await machine.call(name, args);
  expect(error).toBeUndefined();
  return result as unknown as { content: Content[]; isError?: boolean };
}

async function ok(machine: Machine, name: string, args = {}) {
  const result = await call(machine, name, args);
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.content;
}

describe.runIf(process.platform === 'darwin')('native macOS desktop', () => {
  it('offers the desktop tools or explains why not', async () => {
    const { machine, listed, available } = await startNative();
    const discovered = await machine.rpc<{ instructions: string }>(
      'server/discover',
    );
    const instructions = discovered.result!.instructions;
    console.info(`macOS desktop available: ${available}`);
    if (available) {
      expect(listed).toEqual([...desktop.tools, ...localTools]);
      expect(instructions.endsWith(desktop.instructions.available)).toBe(true);
    } else {
      expect(listed).toEqual(localTools);
      const [before] = desktop.instructions.unavailable.split('${hint}');
      expect(instructions).toContain(before);
      expect(instructions).toMatch(/permission|session/);
    }
  });

  it('takes screenshots that match their reported size', async () => {
    const { machine, available } = await startNative();
    if (!available) return;
    const content = await ok(machine, 'desktop_screenshot', { format: 'png' });
    expect(content.map((item) => item.type)).toEqual(['image', 'text']);
    expect(content[0]!.mimeType).toBe('image/png');
    const info = JSON.parse(content[1]!.text!) as {
      width: number;
      height: number;
      screen: { width: number; height: number };
    };
    console.info(`macOS screenshot: ${JSON.stringify(info)}`);
    const image = decodePng(Buffer.from(content[0]!.data!, 'base64'));
    expect([image.width, image.height]).toEqual([info.width, info.height]);
    expect(info.screen.width).toBeGreaterThanOrEqual(info.width);

    const zoom = await ok(machine, 'desktop_zoom', {
      x: 10,
      y: 10,
      width: 64,
      height: 48,
      format: 'png',
    });
    const zoomed = JSON.parse(zoom[1]!.text!) as { width: number };
    const zoomImage = decodePng(Buffer.from(zoom[0]!.data!, 'base64'));
    expect(zoomImage.width).toBe(zoomed.width);

    const jpeg = await ok(machine, 'desktop_screenshot');
    expect(jpeg[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('sends input, lists windows and launches processes', async () => {
    const { machine, available } = await startNative();
    if (!available) return;
    await ok(machine, 'desktop_move', { x: 200, y: 200 });
    await ok(machine, 'desktop_scroll', {
      x: 200,
      y: 200,
      direction: 'down',
      amount: 1,
    });
    await ok(machine, 'desktop_key', { keys: ['shift'] });
    const windows = JSON.parse(
      (await ok(machine, 'desktop_list_windows'))[0]!.text!,
    ) as { id: string; bounds: { width: number } }[];
    for (const window of windows) {
      expect(window.id).toMatch(/^\d+$/);
      expect(window.bounds.width).toBeGreaterThan(1);
    }
    const launched = await ok(machine, 'desktop_launch', {
      command: '/bin/sleep',
      args: ['2'],
      settleMs: 0,
    });
    const { pid } = JSON.parse(launched[0]!.text!) as { pid: number };
    expect(pid).toBeGreaterThan(0);
  });

  it('reports macOS input errors like the TypeScript server', async () => {
    const { machine, available } = await startNative();
    if (!available) return;
    expect(await call(machine, 'desktop_key', { keys: ['cmd+f21'] })).toEqual(
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text: 'Error: macOS has no F21 key; F1 to F20 work',
          },
        ],
        isError: true,
      }),
    );
    expect(await call(machine, 'desktop_focus_window', { id: 'abc' })).toEqual(
      expect.objectContaining({
        content: [
          {
            type: 'text',
            text: 'Input validation error: Invalid arguments for tool desktop_focus_window: id: Invalid string: must match pattern /^\\d+$/',
          },
        ],
        isError: true,
      }),
    );
  });
});
