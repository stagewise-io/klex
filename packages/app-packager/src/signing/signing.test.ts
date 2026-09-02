import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CommandExecutionError,
  type CommandRunner,
  type CommandRunOptions,
} from '../command-runner/index.js';
import { notarizeMacOSArchive, signExecutables } from './signing.js';

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    arguments: readonly string[];
    command: string;
    options?: CommandRunOptions;
  }> = [];

  constructor(private readonly responses: Array<string | Error> = []) {}

  run(
    command: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ) {
    this.calls.push({ command, arguments: arguments_, options });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return {
      command,
      arguments: arguments_,
      stdout: response ?? '',
      stderr: '',
    };
  }
}

describe('complete payload signing', () => {
  it('signs and verifies files in caller-defined order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-sign-many-'));
    const nested = join(directory, 'nested.node');
    const main = join(directory, 'klex');
    writeFileSync(nested, 'nested');
    writeFileSync(main, 'main');
    const runner = new RecordingRunner();
    try {
      const result = await signExecutables({
        files: [nested, main],
        macos: { identity: 'Developer ID Application: stagewise Inc.' },
        mode: 'required',
        platform: 'darwin',
        runner,
      });

      expect(
        runner.calls
          .filter((call) => call.arguments.includes('--sign'))
          .map((call) => call.arguments.at(-1)),
      ).toEqual([nested, main]);
      expect(result).toEqual({
        provider: 'apple-developer-id',
        signed: true,
        verified: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects an empty signing inventory', async () => {
    await expect(signExecutables({ files: [] })).rejects.toThrow(
      'At least one executable is required for signing',
    );
  });

  it('submits and polls an archive with redacted Apple credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner([
      JSON.stringify({ id: 'submission-id' }),
      JSON.stringify({ status: 'Accepted' }),
    ]);
    try {
      await notarizeMacOSArchive({
        environment: {
          APPLE_ID: 'release@example.com',
          APPLE_PASSWORD: 'secret-password',
          APPLE_TEAM_ID: 'TEAMID',
        },
        file: archive,
        runner,
      });

      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[0]).toMatchObject({
        command: 'xcrun',
        options: { sensitiveArgumentIndexes: [6, 8, 10] },
      });
      expect(runner.calls[0]?.arguments).toEqual([
        'notarytool',
        'submit',
        archive,
        '--output-format',
        'json',
        '--apple-id',
        'release@example.com',
        '--password',
        'secret-password',
        '--team-id',
        'TEAMID',
      ]);
      expect(runner.calls[1]?.arguments.slice(0, 3)).toEqual([
        'notarytool',
        'info',
        'submission-id',
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('retries transient notarization polling failures', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner([
      JSON.stringify({ id: 'submission-id' }),
      new CommandExecutionError('temporary polling failure', {
        command: 'xcrun notarytool info',
        stdout: '',
        stderr: '',
      }),
      JSON.stringify({ status: 'In Progress' }),
      JSON.stringify({ status: 'Accepted' }),
    ]);
    const delays: number[] = [];
    try {
      await expect(
        notarizeMacOSArchive({
          environment: {
            APPLE_ID: 'release@example.com',
            APPLE_PASSWORD: 'secret-password',
            APPLE_TEAM_ID: 'TEAMID',
          },
          file: archive,
          maxPollingAttempts: 3,
          pollingIntervalMs: 25,
          runner,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
        }),
      ).resolves.toBe('submission-id');
      expect(delays).toEqual([25, 25]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('includes the Apple log when notarization is rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner([
      JSON.stringify({ id: 'submission-id' }),
      JSON.stringify({ status: 'Invalid' }),
      'The executable has an invalid signature',
    ]);
    try {
      await expect(
        notarizeMacOSArchive({
          environment: {
            APPLE_ID: 'release@example.com',
            APPLE_PASSWORD: 'secret-password',
            APPLE_TEAM_ID: 'TEAMID',
          },
          file: archive,
          runner,
        }),
      ).rejects.toThrow('The executable has an invalid signature');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects incomplete notarization credentials before invoking commands', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner();
    try {
      await expect(
        notarizeMacOSArchive({
          environment: { APPLE_ID: 'release@example.com' },
          file: archive,
          runner,
        }),
      ).rejects.toThrow(
        'macOS notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID',
      );
      expect(runner.calls).toHaveLength(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
