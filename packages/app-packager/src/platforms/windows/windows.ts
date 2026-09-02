import type { CommandRunner } from '../../command-runner/index.js';
import { resolveWindowsSigningConfiguration } from '../../config/index.js';
import type {
  PlatformSigningOptions,
  SigningResult,
} from '../../signing/signing.js';

export function prepareWindowsRuntime(
  file: string,
  runner: CommandRunner,
  environment: NodeJS.ProcessEnv,
): void {
  const signTool = environment.SIGNTOOL_PATH?.trim();
  if (signTool) runner.run(signTool, ['remove', '/s', file]);
}

export function signWindowsExecutable(
  options: PlatformSigningOptions,
): SigningResult {
  const configuration =
    options.windowsSigning ??
    resolveWindowsSigningConfiguration(options.environment, options.mode);
  if (!configuration) return { signed: false, verified: false };

  options.runner.run(configuration.signToolPath, [
    'sign',
    '/v',
    '/debug',
    '/fd',
    'sha256',
    '/tr',
    'http://timestamp.acs.microsoft.com',
    '/td',
    'sha256',
    '/dlib',
    configuration.dlibPath,
    '/dmdf',
    configuration.metadataPath,
    options.file,
  ]);
  verifyWindowsExecutable(options, configuration.signToolPath);
  return {
    signed: true,
    verified: true,
    provider: 'azure-trusted-signing',
  };
}

export function verifyWindowsExecutable(
  options: PlatformSigningOptions,
  configuredSignTool?: string,
): SigningResult {
  const signTool =
    configuredSignTool ?? options.environment.SIGNTOOL_PATH?.trim();
  if (!signTool) {
    throw new Error('SIGNTOOL_PATH is required to verify a Windows signature');
  }
  options.runner.run(signTool, ['verify', '/pa', '/all', '/v', options.file]);
  return {
    signed: true,
    verified: true,
    provider: 'azure-trusted-signing',
  };
}
