import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { helpText, packageVersion, parseCli } from '../src/cli.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'klex-machine-cli-'));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('CLI configuration', () => {
  it('uses defaults and resolves the process cwd', async () => {
    const result = await parseCli([], {}, directory);
    expect(result).toEqual({
      action: 'serve',
      config: {
        cwd: directory,
        host: '127.0.0.1',
        port: 3123,
        logLevel: 'info',
        warnsAboutRemoteAccess: false,
      },
      dataDir: expect.any(String),
      mode: 'enrolled',
    });
  });

  it('gives flags precedence over environment values', async () => {
    const result = await parseCli(
      [
        'serve',
        '--cwd',
        directory,
        '--host',
        '0.0.0.0',
        '--port',
        '4000',
        '--log-level',
        'debug',
      ],
      {
        KLEX_MACHINE_CWD: '/missing',
        KLEX_MACHINE_HOST: 'localhost',
        KLEX_MACHINE_PORT: '5000',
        KLEX_MACHINE_LOG_LEVEL: 'error',
      },
      '/',
    );
    expect(result).toMatchObject({
      action: 'serve',
      config: {
        cwd: directory,
        host: '0.0.0.0',
        port: 4000,
        logLevel: 'debug',
        warnsAboutRemoteAccess: true,
      },
    });
  });

  it('parses cloud enrollment and enrolled serving modes', async () => {
    await expect(
      parseCli(
        [
          'cloud',
          'enroll',
          'single-use-code',
          '--cloud-base-url',
          'https://cloud.example',
          '--data-dir',
          directory,
        ],
        {},
        directory,
      ),
    ).resolves.toEqual({
      action: 'enroll',
      cloudBaseUrl: 'https://cloud.example',
      code: 'single-use-code',
      dataDir: directory,
    });
    await expect(
      parseCli(['serve', '--mode', 'enrolled'], {}, directory),
    ).resolves.toMatchObject({ action: 'serve', mode: 'enrolled' });
  });

  it.each([
    '127.1',
    '127.0.0.1',
    '127.255.255.255',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:127.0.0.2',
  ])('recognizes loopback literal %s', async (host) => {
    await expect(
      parseCli(['serve', '--host', host], {}, directory),
    ).resolves.toMatchObject({
      config: { warnsAboutRemoteAccess: false },
    });
  });

  it.each(['', ' ', '-1', '65536', 'nan', '1.5'])(
    'rejects invalid port %s',
    async (port) => {
      await expect(
        parseCli(['serve', `--port=${port}`], {}, directory),
      ).rejects.toThrow('Invalid port');
    },
  );

  it('does not treat a 127-prefixed hostname as loopback', async () => {
    await expect(
      parseCli(['serve', '--host', '127.example.com'], {}, directory),
    ).resolves.toMatchObject({
      config: { warnsAboutRemoteAccess: true },
    });
  });

  it('rejects a missing cwd and a file cwd', async () => {
    const file = join(directory, 'file');
    await writeFile(file, 'data');
    await expect(
      parseCli(['serve', '--cwd', join(directory, 'missing')], {}, directory),
    ).rejects.toThrow('Working directory');
    await expect(
      parseCli(['serve', '--cwd', file], {}, directory),
    ).rejects.toThrow('Working directory');
  });

  it('supports help and version without a command', async () => {
    await expect(parseCli(['--help'], {}, directory)).resolves.toEqual({
      action: 'help',
    });
    await expect(parseCli(['--version'], {}, directory)).resolves.toEqual({
      action: 'version',
    });
    expect(helpText()).toContain('klex-machine serve');
    expect(helpText()).toContain('klex-machine cloud enroll');
    expect(helpText()).toContain('--cloud-base-url <url>');
    expect(packageVersion()).toBe('0.1.0');
  });

  it('rejects unknown commands', async () => {
    await expect(parseCli(['start'], {}, directory)).rejects.toThrow(
      'Expected command',
    );
  });
});
