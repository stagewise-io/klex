import type { CommandRunner } from '../../command-runner/index.js';
import type {
  PlatformSigningOptions,
  SigningResult,
} from '../../signing/signing.js';

export function prepareLinuxRuntime(): void {}

export function stripLinuxExecutable(
  file: string,
  runner: CommandRunner,
): void {
  runner.run('strip', ['--strip-unneeded', file]);
}

export function signLinuxExecutable(
  options: PlatformSigningOptions,
): SigningResult {
  if (options.mode === 'required') {
    throw new Error('Executable signing is not supported on Linux');
  }
  return { signed: false, verified: false };
}

export function verifyLinuxExecutable(): SigningResult {
  return { signed: false, verified: false };
}
