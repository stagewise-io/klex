import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createKlexAgentPackagerConfig,
  listPackagedCodeFiles,
  packageKlexAgent,
  resolveFfprobeInstaller,
  resolveFfprobeInstallerPackageName,
  resolveLiveKitNativeAddon,
  resolveSharpNativePackageNames,
} from './package-exe';

describe('Klex Bot executable packaging', () => {
  it('defines the Klex Bot SEA inputs and macOS signing policy', () => {
    const config = createKlexAgentPackagerConfig({
      environment: {
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: stagewise Inc.',
      },
    });

    expect(config).toEqual({
      name: 'klex',
      entry: 'dist/main.mjs',
      outputDirectory: 'dist',
      mainFormat: 'module',
      assets: {
        'javascript-sandbox-worker.js': 'dist/javascript-sandbox-worker.js',
        'livekit-rtc.node': resolveLiveKitNativeAddon(),
      },
      useCodeCache: false,
      signing: { mode: 'optional' },
      macos: {
        identity: 'Developer ID Application: stagewise Inc.',
        entitlements: {
          allowJit: true,
          allowUnsignedExecutableMemory: true,
          disableLibraryValidation: true,
        },
      },
    });
  });

  it('resolves native payloads for every release target', () => {
    expect(resolveLiveKitNativeAddon()).toMatch(/rtc-node.*\.node$/);
    expect(resolveFfprobeInstaller().binaryPath).toMatch(/ffprobe$/);
    expect(
      [
        ['darwin', 'arm64'],
        ['darwin', 'x64'],
        ['linux', 'arm64'],
        ['linux', 'x64'],
        ['win32', 'x64'],
      ].map(([platform, architecture]) =>
        resolveFfprobeInstallerPackageName(
          platform as NodeJS.Platform,
          architecture as NodeJS.Architecture,
        ),
      ),
    ).toEqual([
      '@ffprobe-installer/darwin-arm64',
      '@ffprobe-installer/darwin-x64',
      '@ffprobe-installer/linux-arm64',
      '@ffprobe-installer/linux-x64',
      '@ffprobe-installer/win32-x64',
    ]);
    expect(() => resolveLiveKitNativeAddon('aix', 'ppc64')).toThrow(
      'Klex release target is not supported for aix-ppc64',
    );
    expect(() => resolveFfprobeInstallerPackageName('aix', 'ppc64')).toThrow(
      'Klex release target is not supported for aix-ppc64',
    );
  });

  it('selects the Sharp payload layout for each platform', () => {
    expect(resolveSharpNativePackageNames('win32', 'x64')).toEqual({
      addon: '@img/sharp-win32-x64',
    });
    expect(resolveSharpNativePackageNames('darwin', 'arm64')).toEqual({
      addon: '@img/sharp-darwin-arm64',
      libvips: '@img/sharp-libvips-darwin-arm64',
    });
    expect(resolveSharpNativePackageNames('linux', 'x64')).toEqual({
      addon: '@img/sharp-linux-x64',
      libvips: '@img/sharp-libvips-linux-x64',
    });
  });

  it.each(['darwin', 'win32'] as const)(
    'requires main-executable signing for %s release builds',
    (platform) => {
      const config = createKlexAgentPackagerConfig({
        environment: { KLEX_RELEASE_CHANNEL: 'stable' },
        platform,
      });
      expect(config.signing).toEqual({ mode: 'required' });
      expect(config.macos?.notarization).toBeUndefined();
    },
  );

  it('keeps Linux release builds unsigned', () => {
    const config = createKlexAgentPackagerConfig({
      environment: { KLEX_RELEASE_CHANNEL: 'stable' },
      platform: 'linux',
    });
    expect(config.signing).toEqual({ mode: 'optional' });
  });

  it('rejects the notarization escape hatch for releases', () => {
    expect(() =>
      createKlexAgentPackagerConfig({
        environment: { KLEX_RELEASE_CHANNEL: 'nightly' },
        skipNotarize: true,
      }),
    ).toThrow('--skip-notarize is not allowed for release builds');
  });

  it('lists native and executable payloads with the main executable last', () => {
    const directory = mkdtempSync(join(tmpdir(), 'klex-inventory-'));
    try {
      mkdirSync(join(directory, 'node_modules'), { recursive: true });
      writeFileSync(join(directory, 'klex'), 'main');
      chmodSync(join(directory, 'klex'), 0o755);
      writeFileSync(join(directory, 'worker.js'), 'worker');
      writeFileSync(join(directory, 'node_modules', 'addon.node'), 'native');
      writeFileSync(join(directory, 'node_modules', 'tool'), 'tool');
      chmodSync(join(directory, 'node_modules', 'tool'), 0o755);

      expect(listPackagedCodeFiles(directory, 'darwin')).toEqual([
        join(directory, 'node_modules', 'addon.node'),
        join(directory, 'node_modules', 'tool'),
        join(directory, 'klex'),
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects unsupported packaging arguments before packaging', async () => {
    await expect(packageKlexAgent(['--unsupported'], {})).rejects.toThrow(
      'Unknown option',
    );
  });

  it('accepts the package-manager argument separator', async () => {
    await expect(packageKlexAgent(['--', '--unsupported'], {})).rejects.toThrow(
      'Unknown option',
    );
  });
});
