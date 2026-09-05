import { describe, expect, it, vi } from 'vitest';

import type { ManagedInstallation } from './discovery';
import { UpdateManager } from './update-manager';

const installation: ManagedInstallation = {
  channel: 'stable',
  currentExecutable: '/install/current/klex',
  receipt: {
    archiveSha256: 'a'.repeat(64),
    binDir: '/install/bin',
    channel: 'stable',
    installDir: '/install',
    installedAt: '2026-09-05T00:00:00Z',
    manifestUrl: 'https://example.com/ignored.json',
    modifiedPathFiles: [],
    schemaVersion: 1,
    target: 'linux-x64-gnu',
    version: '1.2.3',
  },
  root: '/install',
  runningExecutable: '/install/versions/1.2.3/klex',
  target: 'linux-x64-gnu',
  version: '1.2.3',
};

function manifest(version: string) {
  return {
    artifacts: [
      {
        archiveFileName: `klex-${version}-linux-x64-gnu.tar.gz`,
        archiveSha256: 'b'.repeat(64),
        archiveSize: 100,
        nodeVersion: '26.1.0',
        notarized: false,
        signed: false,
        target: 'linux-x64-gnu',
        url: 'https://example.com/klex.tar.gz',
        verified: false,
      },
    ],
    channel: 'stable',
    gitCommit: 'c'.repeat(40),
    schemaVersion: 1,
    version,
  };
}

function validatedInstallation(version: string): ManagedInstallation {
  return {
    ...installation,
    currentExecutable: `/install/current/klex`,
    receipt: { ...installation.receipt, version },
    runningExecutable: `/install/versions/${version}/klex`,
    version,
  };
}

function fetchManifest(version: string): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(manifest(version)), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
  );
}

describe('UpdateManager', () => {
  it.each(['1.2.3', '1.2.2'])(
    'does not offer equal or older release %s',
    async (version) => {
      const manager = new UpdateManager({
        installation,
        fetchImplementation: fetchManifest(version),
        onRestartRequested: vi.fn(),
      });
      await manager.check();
      expect(manager.getState()).toEqual({ status: 'up-to-date' });
    },
  );

  it('silently returns to idle on network and metadata failures', async () => {
    const manager = new UpdateManager({
      installation,
      fetchImplementation: vi.fn(async () => {
        throw new Error('offline');
      }),
      onRestartRequested: vi.fn(),
    });
    await manager.check();
    expect(manager.getState()).toEqual({ status: 'idle' });
  });

  it('preserves an existing offer when a later check fails', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(manifest('1.2.4')), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    const manager = new UpdateManager({
      installation,
      fetchImplementation,
      onRestartRequested: vi.fn(),
    });
    await manager.check();
    await manager.check();
    expect(manager.getState()).toEqual({
      status: 'available',
      version: '1.2.4',
    });
  });

  it('deduplicates checks and install attempts, then requests restart after success', async () => {
    let finishInstall: (() => void) | undefined;
    const runner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const restart = vi.fn();
    const fetchImplementation = fetchManifest('1.2.4');
    const manager = new UpdateManager({
      installation,
      fetchImplementation,
      onRestartRequested: restart,
      runInstaller: runner,
      validateInstallation: async (version) => validatedInstallation(version),
    });
    await Promise.all([manager.check(), manager.check()]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(manager.getState()).toEqual({
      status: 'available',
      version: '1.2.4',
    });
    const first = manager.install();
    const second = manager.install();
    expect(runner).toHaveBeenCalledOnce();
    finishInstall?.();
    await Promise.all([first, second]);
    expect(restart).toHaveBeenCalledWith(
      expect.objectContaining({
        runningExecutable: '/install/versions/1.2.4/klex',
      }),
    );
    expect(manager.getState()).toEqual({
      status: 'restarting',
      version: '1.2.4',
    });
  });

  it('cancels an active installer before resolving the cancellation request', async () => {
    const runner = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('installer terminated')),
            { once: true },
          );
        }),
    );
    const manager = new UpdateManager({
      installation,
      fetchImplementation: fetchManifest('1.2.4'),
      onRestartRequested: vi.fn(),
      runInstaller: runner,
    });
    await manager.check();
    const install = manager.install();
    await manager.cancelInstall();
    await install;
    expect(manager.getState()).toEqual({
      status: 'failed',
      message: 'Update cancelled',
      version: '1.2.4',
    });
  });

  it('rejects an installer result that cannot be verified', async () => {
    const restart = vi.fn();
    const manager = new UpdateManager({
      installation,
      fetchImplementation: fetchManifest('1.2.4'),
      onRestartRequested: restart,
      runInstaller: vi.fn(async () => undefined),
      validateInstallation: async () => null,
    });
    await manager.check();
    await manager.install();
    expect(manager.getState()).toMatchObject({
      status: 'failed',
      message: 'Installed update could not be verified',
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it('exposes installer failure and permits retry', async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('another install operation is already running'),
      )
      .mockResolvedValueOnce(undefined);
    const manager = new UpdateManager({
      installation,
      fetchImplementation: fetchManifest('1.2.4'),
      onRestartRequested: vi.fn(),
      runInstaller: runner,
      validateInstallation: async (version) => validatedInstallation(version),
    });
    await manager.check();
    await manager.install();
    expect(manager.getState()).toMatchObject({ status: 'failed' });
    await manager.install();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
