import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MacosDesktopProvider } from '../src/desktop/platform/macos.js';
import { describeDesktopProviderContract } from './desktop-provider-contract.js';
import { ENC, TestRfbClient } from './rfb-test-client.js';

/**
 * Runs against the real helper and window server, so only on macOS after a
 * build has produced dist/macos/klex-desktop-helper. Whether computer use is
 * on depends on the TCC grants of whatever started the test run.
 */
const helper = fileURLToPath(
  new URL('../dist/macos/klex-desktop-helper', import.meta.url),
);
const native = process.platform === 'darwin' && existsSync(helper);
const provider = () =>
  new MacosDesktopProvider({ helperPath: helper, warn: () => undefined });
const capabilities = native ? await provider().probe() : undefined;
if (capabilities) {
  console.info(`macOS desktop probe: ${JSON.stringify(capabilities)}`);
}

function runHelper(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(helper, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number(error.code ?? 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

describe.runIf(native)('macOS desktop helper on this Mac', () => {
  it('reports its version and the main display in points and pixels', async () => {
    const version = await runHelper(['version']);
    expect(version.code).toBe(0);
    expect(JSON.parse(version.stdout)).toEqual({ version: '2' });
    const display = await runHelper(['display']);
    expect(display.code).toBe(0);
    const geometry = JSON.parse(display.stdout);
    console.info(`macOS display: ${display.stdout.trim()}`);
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.pixelWidth).toBeGreaterThanOrEqual(geometry.width);
    expect(geometry.pixelHeight).toBeGreaterThanOrEqual(geometry.height);
  });

  it('lists windows as JSON', async () => {
    const windows = await runHelper(['windows']);
    expect(windows.code).toBe(0);
    expect(Array.isArray(JSON.parse(windows.stdout))).toBe(true);
  });

  it('rejects bad arguments with exit code 2', async () => {
    expect((await runHelper(['click', '1', '1', 'left', '1'])).code).toBe(2);
    expect((await runHelper(['key', 'cmd|char:é'])).code).toBe(2);
    expect((await runHelper(['nope'])).code).toBe(2);
    expect((await runHelper(['stream', 'now'])).code).toBe(2);
  });

  it('reports a permission hint whenever computer use is off', () => {
    if (capabilities?.computerUse) return;
    expect(capabilities).toEqual({
      computerUse: false,
      stream: false,
      hint: expect.stringMatching(/permission|session/),
    });
  });

  it('refuses input without Accessibility permission instead of dropping it', async () => {
    const probe = JSON.parse((await runHelper(['probe'])).stdout);
    console.info(`macOS helper probe: ${JSON.stringify(probe)}`);
    if (probe.accessibility) return;
    const move = await runHelper(['move', '1', '1']);
    expect(move.code).toBe(3);
    expect(move.stderr).toMatch(/Accessibility permission is missing/);
  });

  it('refuses to stream without permission', async () => {
    const probe = JSON.parse((await runHelper(['probe'])).stdout);
    if (probe.screenRecording && probe.accessibility) return;
    const stream = await runHelper(['stream']);
    expect(stream.code).toBe(3);
    expect(stream.stdout).toBe('');
  });

  it.runIf(capabilities?.computerUse)(
    'streams the main display over RFB',
    { timeout: 30_000 },
    async () => {
      const desktop = provider();
      const client = new TestRfbClient(await desktop.openStream());
      try {
        await client.handshake();
        expect(client.width).toBeGreaterThan(0);
        client.setEncodings([ENC.tight, ENC.raw]);
        client.request(false);
        const rects = await client.nextUpdate();
        const area = rects.reduce(
          (sum, rect) => sum + rect.width * rect.height,
          0,
        );
        expect(area).toBe(client.width * client.height);
      } finally {
        client.socket.destroy();
      }
    },
  );
});

if (capabilities) {
  describeDesktopProviderContract(
    'macOS on this Mac',
    { computerUse: capabilities.computerUse, stream: capabilities.computerUse },
    async () => ({ provider: provider() }),
  );
}
