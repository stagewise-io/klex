import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeAppPackagerConfig,
  resolveWindowsSigningConfiguration,
} from './config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('normalizeAppPackagerConfig', () => {
  it('resolves paths, defaults, assets, and an executable suffix', () => {
    const directory = createFixture();
    const config = normalizeAppPackagerConfig(
      {
        name: 'example',
        entry: 'entry.cjs',
        outputDirectory: 'release',
        assets: { fixture: 'asset.txt' },
      },
      {
        baseDirectory: directory,
        platform: 'win32',
        architecture: 'x64',
        nodeVersion: 'v22.0.0',
        environment: {},
      },
    );

    expect(config.outputPath).toBe(join(directory, 'release', 'example.exe'));
    expect(config.entry).toBe(join(directory, 'entry.cjs'));
    expect(config.assets).toEqual([
      { name: 'fixture', path: join(directory, 'asset.txt') },
    ]);
    expect(config.signingMode).toBe('optional');
  });

  it('rejects missing inputs and unsupported target mismatches', () => {
    const directory = createFixture();
    expect(() =>
      normalizeAppPackagerConfig(
        { name: 'example', entry: 'missing.cjs', outputDirectory: 'out' },
        { baseDirectory: directory },
      ),
    ).toThrow('entry point does not exist');
    expect(() =>
      normalizeAppPackagerConfig(
        {
          name: 'example',
          entry: 'entry.cjs',
          outputDirectory: 'out',
          expectedArchitecture: process.arch,
        },
        {
          baseDirectory: directory,
          architecture: process.arch === 'arm64' ? 'x64' : 'arm64',
        },
      ),
    ).toThrow('Architecture');
  });
});

describe('resolveWindowsSigningConfiguration', () => {
  it('allows no signing configuration in optional mode', () => {
    expect(resolveWindowsSigningConfiguration({}, 'optional')).toBeUndefined();
  });

  it('fails on partial configuration and absent release configuration', () => {
    expect(() =>
      resolveWindowsSigningConfiguration(
        { SIGNTOOL_PATH: '/missing/signtool.exe' },
        'optional',
      ),
    ).toThrow('incomplete');
    expect(() => resolveWindowsSigningConfiguration({}, 'required')).toThrow(
      'required',
    );
  });
});

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'app-packager-config-test-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'entry.cjs'), 'console.log("ok")');
  writeFileSync(join(directory, 'asset.txt'), 'asset');
  return directory;
}
