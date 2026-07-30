import { describe, expect, it } from 'vitest';

import type {
  CommandRunner,
  CommandRunOptions,
} from '../../command-runner/index.js';
import { prepareWindowsRuntime, signWindowsExecutable } from './windows.js';

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];

  run(
    command: string,
    arguments_: readonly string[],
    _options?: CommandRunOptions,
  ) {
    this.calls.push([command, ...arguments_]);
    return { command, arguments: arguments_, stdout: '', stderr: '' };
  }
}

describe('Windows signing adapter', () => {
  it('removes the inherited signature before signing and verification', () => {
    const runner = new RecordingRunner();
    const environment = {
      SIGNTOOL_PATH: 'signtool.exe',
      AZURE_TRUSTED_SIGNING_DLIB_PATH: 'trusted-signing.dll',
      AZURE_TRUSTED_SIGNING_METADATA_PATH: 'metadata.json',
    };
    prepareWindowsRuntime('app.exe', runner, environment);
    const result = signWindowsExecutable({
      file: 'app.exe',
      mode: 'required',
      macos: {},
      environment,
      runner,
      windowsSigning: {
        signToolPath: 'signtool.exe',
        dlibPath: 'trusted-signing.dll',
        metadataPath: 'metadata.json',
      },
    });

    expect(runner.calls.map((call) => call.slice(0, 2))).toEqual([
      ['signtool.exe', 'remove'],
      ['signtool.exe', 'sign'],
      ['signtool.exe', 'verify'],
    ]);
    expect(result).toEqual({
      signed: true,
      verified: true,
      provider: 'azure-trusted-signing',
    });
  });
});
