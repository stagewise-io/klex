import { describe, expect, it } from 'vitest';

import { resolveNativeAssetChecks } from './smoke-exe';

describe('Klex Agent executable smoke checks', () => {
  it('uses the bundled Sharp libvips DLLs on Windows', () => {
    const checks = resolveNativeAssetChecks('/distribution', 'win32', 'x64');

    expect(checks.map(({ name }) => name)).not.toContain('sharp libvips');
    expect(checks.find(({ name }) => name === 'sharp addon')?.path).toContain(
      '@img/sharp-win32-x64',
    );
  });

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64'],
  ] as const)(
    'checks the separate Sharp libvips package on %s',
    (platform, architecture) => {
      const checks = resolveNativeAssetChecks(
        '/distribution',
        platform,
        architecture,
      );

      expect(
        checks.find(({ name }) => name === 'sharp libvips')?.path,
      ).toContain(`@img/sharp-libvips-${platform}-${architecture}`);
    },
  );
});
