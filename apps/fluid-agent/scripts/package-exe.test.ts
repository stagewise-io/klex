import { describe, expect, it } from 'vitest';

import {
  createFluidAgentPackagerConfig,
  packageFluidAgent,
} from './package-exe';

describe('Fluid Agent executable packaging', () => {
  it('defines the Fluid Agent SEA inputs and macOS signing policy', () => {
    const config = createFluidAgentPackagerConfig({
      environment: {
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: stagewise Inc.',
      },
    });

    expect(config).toEqual({
      name: 'fluid-agent',
      entry: 'dist/main.js',
      outputDirectory: 'dist',
      assets: {
        'javascript-sandbox-worker.js': 'dist/javascript-sandbox-worker.js',
      },
      useCodeCache: true,
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

  it('enables and staples notarization with complete credentials', () => {
    const config = createFluidAgentPackagerConfig({
      environment: {
        APPLE_ID: 'release@example.com',
        APPLE_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAMID',
      },
    });

    expect(config.macos?.notarization).toEqual({
      enabled: true,
      staple: true,
    });
  });

  it('disables notarization when explicitly skipped', () => {
    const config = createFluidAgentPackagerConfig({
      environment: {
        APPLE_ID: 'release@example.com',
        APPLE_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAMID',
      },
      skipNotarize: true,
    });

    expect(config.macos?.notarization).toBeUndefined();
  });

  it.each([
    {},
    { APPLE_ID: 'release@example.com' },
    {
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-password',
    },
  ])(
    'disables notarization with absent or partial credentials',
    (environment) => {
      const config = createFluidAgentPackagerConfig({ environment });

      expect(config.macos?.notarization).toBeUndefined();
    },
  );

  it('rejects unsupported packaging arguments before packaging', async () => {
    await expect(packageFluidAgent(['--unsupported'], {})).rejects.toThrow(
      'Unknown option',
    );
  });

  it('accepts the package-manager argument separator', async () => {
    await expect(
      packageFluidAgent(['--', '--unsupported'], {}),
    ).rejects.toThrow('Unknown option');
  });
});
