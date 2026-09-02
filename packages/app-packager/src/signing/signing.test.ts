import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  CommandRunner,
  CommandRunOptions,
} from '../command-runner/index.js';
import { notarizeMacOSArchive, signExecutables } from './signing.js';

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    arguments: readonly string[];
    command: string;
    options?: CommandRunOptions;
  }> = [];

  run(
    command: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ) {
    this.calls.push({ command, arguments: arguments_, options });
    return { command, arguments: arguments_, stdout: '', stderr: '' };
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

  it('submits an archive with redacted Apple credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner();
    try {
      notarizeMacOSArchive({
        environment: {
          APPLE_ID: 'release@example.com',
          APPLE_PASSWORD: 'secret-password',
          APPLE_TEAM_ID: 'TEAMID',
        },
        file: archive,
        runner,
      });

      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]).toMatchObject({
        command: 'xcrun',
        options: { sensitiveArgumentIndexes: [4, 6, 8] },
      });
      expect(runner.calls[0]?.arguments).toEqual([
        'notarytool',
        'submit',
        archive,
        '--apple-id',
        'release@example.com',
        '--password',
        'secret-password',
        '--team-id',
        'TEAMID',
        '--wait',
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects incomplete notarization credentials before invoking commands', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
    const archive = join(directory, 'payload.zip');
    writeFileSync(archive, 'zip');
    const runner = new RecordingRunner();
    try {
      expect(() =>
        notarizeMacOSArchive({
          environment: { APPLE_ID: 'release@example.com' },
          file: archive,
          runner,
        }),
      ).toThrow(
        'macOS notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID',
      );
      expect(runner.calls).toHaveLength(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
