import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli, temporaryDirectory } from '../src/harness.js';

const errorLine = (stderr: string) =>
  stderr.trim().replace(/^klex-machine(?:-rs)?: /, '');

describe('command line', () => {
  it('prints help and version on stdout', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    for (const fragment of [
      'serve',
      'cloud enroll',
      'cloud bootstrap',
      '--cloud-base-url <url>',
      '--no-serve',
      'KLEX_MACHINE_OMIT_HOST_DETAILS',
    ])
      expect(help.stdout).toContain(fragment);
    const version = await runCli(['-v']);
    expect(version).toMatchObject({ code: 0, stderr: '' });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    [['start'], 'Expected command'],
    [['serve', '--port=65536'], 'Invalid port'],
    [['serve', '--port', '1.5'], 'Invalid port'],
    [['serve', '--no-serve'], 'only valid with cloud enroll'],
    [['serve', '--bogus'], "Unknown option '--bogus'"],
    [['cloud', 'bootstrap'], '--enrollment-code-file'],
    [
      ['cloud', 'enroll', 'code', '--mode', 'local'],
      '--mode cannot be used with cloud enroll',
    ],
    [
      ['cloud', 'enroll', 'code', '--port', '4000', '--log-level', 'debug'],
      '--port, --log-level only apply to --mode local',
    ],
  ])('rejects %j', async (args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(errorLine(result.stderr)).toContain(message);
  });

  it('rejects invalid environment configuration', async () => {
    const omit = await runCli([], {
      env: { KLEX_MACHINE_OMIT_HOST_DETAILS: 'yes' },
    });
    expect(omit.code).toBe(1);
    expect(errorLine(omit.stderr)).toContain(
      'Invalid KLEX_MACHINE_OMIT_HOST_DETAILS',
    );
    const port = await runCli(['serve', '--mode', 'local'], {
      env: { KLEX_MACHINE_PORT: 'nope' },
    });
    expect(port.code).toBe(1);
    expect(errorLine(port.stderr)).toContain('Invalid port');
  });

  it('rejects a missing or non-directory cwd', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'file');
    await writeFile(file, 'data');
    for (const cwd of [join(directory, 'missing'), file]) {
      const result = await runCli(['serve', '--mode', 'local', '--cwd', cwd]);
      expect(result.code).toBe(1);
      expect(errorLine(result.stderr)).toContain('Working directory');
    }
  });
});
