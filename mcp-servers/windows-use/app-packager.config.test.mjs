import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createAppPackagerConfig,
  resolveSigningMode,
} from './app-packager.config.mjs';

describe('Windows Use app-packager config', () => {
  it('invokes the built CLI without relying on an install-time bin shim', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.scripts['build:exe']).toContain(
      'node ../../packages/app-packager/dist/cli/cli.js package',
    );
    expect(packageJson.scripts['build:exe']).not.toContain(
      '&& app-packager package',
    );
  });

  it('defines the stable executable packaging policy', () => {
    expect(createAppPackagerConfig({})).toEqual({
      name: 'stagewise-windows-use',
      entry: 'dist/main.js',
      outputDirectory: 'dist',
      useCodeCache: true,
      signing: { mode: 'optional' },
    });
  });

  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'Yes'])(
    'requires signing for %s',
    (value) => {
      expect(resolveSigningMode({ WINDOWS_SIGNING_REQUIRED: value })).toBe(
        'required',
      );
    },
  );

  it.each([undefined, '', '0', 'false', 'no', ' true ', 'unrelated'])(
    'keeps signing optional for %s',
    (value) => {
      expect(resolveSigningMode({ WINDOWS_SIGNING_REQUIRED: value })).toBe(
        'optional',
      );
    },
  );
});
