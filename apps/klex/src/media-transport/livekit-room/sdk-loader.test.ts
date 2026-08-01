import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadLiveKitSdk, prepareLiveKitNativeRuntime } from './sdk-loader';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-livekit-loader-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('prepareLiveKitNativeRuntime', () => {
  it('does nothing outside a SEA', async () => {
    const environment: NodeJS.ProcessEnv = {};
    await expect(
      prepareLiveKitNativeRuntime({ sea: false, environment }),
    ).resolves.toBeUndefined();
    expect(environment.NAPI_RS_NATIVE_LIBRARY_PATH).toBeUndefined();
  });

  it('extracts the SEA asset to a stable private versioned path', async () => {
    const cacheDirectory = await temporaryDirectory();
    const environment: NodeJS.ProcessEnv = {};
    const target = await prepareLiveKitNativeRuntime({
      sea: true,
      asset: Uint8Array.from([1, 2, 3]).buffer,
      cacheDirectory,
      environment,
      platform: 'darwin',
      architecture: 'arm64',
    });
    expect(target).toBe(
      join(cacheDirectory, 'rtc-node-0.12.68-darwin-arm64.node'),
    );
    expect(environment.NAPI_RS_NATIVE_LIBRARY_PATH).toBe(target);
    await expect(readFile(target as string)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(target as string)).mode & 0o777).toBe(0o600);

    await prepareLiveKitNativeRuntime({
      sea: true,
      asset: Uint8Array.from([9]).buffer,
      cacheDirectory,
      environment,
      platform: 'darwin',
      architecture: 'arm64',
    });
    await expect(readFile(target as string)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
  });
});

describe('loadLiveKitSdk', () => {
  it('initializes and disposes the installed normal Node SDK', async () => {
    const sdk = await loadLiveKitSdk();
    await expect(sdk.dispose()).resolves.toBeUndefined();
  });
});
