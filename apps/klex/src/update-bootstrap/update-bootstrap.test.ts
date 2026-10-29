import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { parseCliArgs } from '@/cli';
import { type ManagedInstallation, UpdateManager } from '@/self-update';

import {
  createUpdateBootstrap,
  type UpdateBootstrap,
} from './update-bootstrap';

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

function manifest(version: string): Response {
  return new Response(
    JSON.stringify({
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
    }),
    { status: 200 },
  );
}

const instances: UpdateBootstrap[] = [];

function setup(options: { autoUpdate?: boolean; managed?: boolean } = {}) {
  const logging = createLogger({ name: 'test', console: false });
  const events: string[] = [];
  let version = '1.2.3';
  const fetchImplementation = vi.fn<typeof fetch>(async () => {
    events.push('check');
    return manifest(version);
  });
  const runInstaller = vi.fn(async () => {
    events.push('install');
  });
  const application = {
    start: vi.fn(async () => {
      events.push('start');
      return true;
    }),
    close: vi.fn(async () => {
      events.push('close');
    }),
    requestExit: vi.fn(),
    requestTermination: vi.fn(),
    requestRestart: vi.fn(async () => {
      events.push('drain-and-restart');
    }),
  };
  const loadApplication = vi.fn(async () => {
    events.push('import');
    return application;
  });
  const discoverInstallation = vi.fn(async () =>
    options.managed === false ? null : installation,
  );
  const restartProcess = vi.fn(async () => {
    events.push('restart');
    return 0;
  });
  const exit = vi.fn();
  const disposeLogging = vi.fn(async () => undefined);
  const onStartupFailure = vi.fn();
  const bootstrap = createUpdateBootstrap({
    logging,
    cli: parseCliArgs([
      '--headless',
      '--data-dir',
      'agents/selected',
      ...(options.autoUpdate === false ? [] : ['--auto-update']),
    ]),
    loadApplication,
    discoverInstallation,
    createUpdateManager: (managerOptions) =>
      new UpdateManager({
        ...managerOptions,
        fetchImplementation,
        runInstaller,
        validateInstallation: async (nextVersion) => ({
          ...installation,
          receipt: { ...installation.receipt, version: nextVersion },
          version: nextVersion,
          runningExecutable: `/install/versions/${nextVersion}/klex`,
        }),
      }),
    restartProcess,
    exit,
    disposeLogging,
    onStartupFailure,
  });
  instances.push(bootstrap);
  return {
    bootstrap,
    application,
    loadApplication,
    discoverInstallation,
    fetchImplementation,
    runInstaller,
    restartProcess,
    exit,
    events,
    disposeLogging,
    onStartupFailure,
    publish: (nextVersion: string) => {
      version = nextVersion;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('KLEX_AUTO_UPDATE', '0');
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('update-first bootstrap', () => {
  it('does not import or start the application until an initial update check finishes', async () => {
    const test = setup();
    let complete: ((response: Response) => void) | undefined;
    test.fetchImplementation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const starting = test.bootstrap.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.loadApplication).not.toHaveBeenCalled();
    complete?.(manifest('1.2.3'));
    await starting;
    expect(test.events).toEqual(['import', 'start']);
    expect(test.fetchImplementation).toHaveBeenCalledOnce();
  });

  it('installs and restarts an available update without importing any agent code', async () => {
    const test = setup();
    test.publish('1.2.4');
    let finish: (() => void) | undefined;
    test.runInstaller.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const starting = test.bootstrap.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.loadApplication).not.toHaveBeenCalled();
    expect(test.restartProcess).not.toHaveBeenCalled();
    finish?.();
    await starting;
    await vi.advanceTimersByTimeAsync(0);
    expect(test.loadApplication).not.toHaveBeenCalled();
    expect(test.restartProcess).toHaveBeenCalledOnce();
    expect(test.restartProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        launcher: installation.currentExecutable,
        arguments: process.argv.slice(2),
        cwd: process.cwd(),
        environment: expect.objectContaining({
          KLEX_DATA_DIR: expect.stringContaining('agents/selected'),
        }),
      }),
    );
    expect(test.exit).toHaveBeenCalledWith(0);
  });

  it('continues startup after an offline check and retries later', async () => {
    const test = setup();
    test.fetchImplementation.mockRejectedValueOnce(new Error('offline'));
    await test.bootstrap.start();
    expect(test.application.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled initial network check to ten seconds', async () => {
    const test = setup();
    test.fetchImplementation.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const starting = test.bootstrap.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(test.loadApplication).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(test.application.start).toHaveBeenCalledOnce();
  });

  it('continues the old runtime after installation failure and retries the offer', async () => {
    const test = setup();
    test.publish('1.2.4');
    test.runInstaller.mockRejectedValueOnce(new Error('installer failed'));
    await test.bootstrap.start();
    expect(test.application.start).toHaveBeenCalledOnce();
    expect(test.restartProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.runInstaller).toHaveBeenCalledTimes(2);
    expect(test.application.requestRestart).toHaveBeenCalledOnce();
  });

  it.each(['migration', 'service'])(
    'cleans up a %s startup failure, stays alive, and installs a later healing release without retrying the agent',
    async (reason) => {
      const test = setup();
      test.application.start.mockRejectedValueOnce(
        new Error(`${reason} failed`),
      );
      await test.bootstrap.start();
      expect(test.application.close).toHaveBeenCalledOnce();
      expect(test.onStartupFailure).toHaveBeenCalledOnce();
      expect(test.exit).not.toHaveBeenCalled();
      expect(test.disposeLogging).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      test.publish('1.2.4');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(test.events.indexOf('close')).toBeLessThan(
        test.events.indexOf('install'),
      );
      expect(test.restartProcess).toHaveBeenCalledOnce();
      expect(test.application.start).toHaveBeenCalledOnce();
      expect(test.loadApplication).toHaveBeenCalledOnce();
    },
  );

  it('recovers even when importing the application itself throws', async () => {
    const test = setup();
    test.loadApplication.mockRejectedValueOnce(
      new Error('native addon import failed'),
    );
    await test.bootstrap.start();
    test.publish('1.2.4');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.restartProcess).toHaveBeenCalledOnce();
    expect(test.application.start).not.toHaveBeenCalled();
  });

  it('keeps retrying when the installer fails in recovery', async () => {
    const test = setup();
    test.application.start.mockRejectedValueOnce(new Error('bad config'));
    await test.bootstrap.start();
    test.publish('1.2.4');
    test.runInstaller.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.restartProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.runInstaller).toHaveBeenCalledTimes(2);
    expect(test.restartProcess).toHaveBeenCalledOnce();
  });

  it('delegates healthy update restarts to the existing drain lifecycle', async () => {
    const test = setup();
    await test.bootstrap.start();
    test.publish('1.2.4');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.application.requestRestart).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.2.4' }),
    );
    expect(test.restartProcess).not.toHaveBeenCalled();
    expect(test.events).toEqual([
      'check',
      'import',
      'start',
      'check',
      'install',
      'drain-and-restart',
    ]);
  });

  it.each([{ autoUpdate: false }, { managed: false }])(
    'leaves non-auto or unmanaged startup unchanged: %j',
    async (options) => {
      const test = setup(options);
      await test.bootstrap.start();
      expect(test.application.start).toHaveBeenCalledOnce();
      expect(test.fetchImplementation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if ('autoUpdate' in options)
        expect(test.discoverInstallation).not.toHaveBeenCalled();
    },
  );

  it('does not hide startup errors or idle forever without an updater', async () => {
    const test = setup({ managed: false });
    test.application.start.mockRejectedValueOnce(new Error('bad config'));
    await expect(test.bootstrap.start()).rejects.toThrow('bad config');
    expect(test.application.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling and removes signal handlers when closed in recovery', async () => {
    const before = process.listenerCount('SIGTERM');
    const test = setup();
    test.application.start.mockRejectedValueOnce(new Error('bad config'));
    await test.bootstrap.start();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await test.bootstrap.close();
    await test.bootstrap.close();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(test.fetchImplementation).toHaveBeenCalledOnce();
  });

  it('is idempotent and leaves close-before-start harmless', async () => {
    const test = setup();
    await test.bootstrap.close();
    await Promise.all([test.bootstrap.start(), test.bootstrap.start()]);
    expect(test.discoverInstallation).toHaveBeenCalledOnce();
    expect(test.application.start).toHaveBeenCalledOnce();
  });
});
