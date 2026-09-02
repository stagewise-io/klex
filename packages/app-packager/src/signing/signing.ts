import { existsSync, statSync } from 'node:fs';

import {
  type CommandRunner,
  createCommandRunner,
} from '../command-runner/index.js';
import {
  type MacOSPackagingConfig,
  resolveMacOSNotarizationConfiguration,
  type SigningMode,
  type WindowsSigningConfiguration,
} from '../config/index.js';
import { getPlatformAdapter } from '../platforms/index.js';

export type SigningProvider =
  | 'azure-trusted-signing'
  | 'apple-developer-id'
  | 'apple-ad-hoc';

export interface SigningResult {
  readonly signed: boolean;
  readonly verified: boolean;
  readonly provider?: SigningProvider;
}

export interface SignExecutableOptions {
  readonly file: string;
  readonly mode?: SigningMode;
  readonly macos?: MacOSPackagingConfig;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
}

export interface SignExecutablesOptions
  extends Omit<SignExecutableOptions, 'file'> {
  readonly files: readonly string[];
}

export interface NotarizeMacOSArchiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly file: string;
  readonly runner?: CommandRunner;
}

export interface VerifyExecutableOptions {
  readonly file: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
}

export interface PlatformSigningOptions {
  readonly file: string;
  readonly mode: SigningMode;
  readonly macos: MacOSPackagingConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly runner: CommandRunner;
  readonly windowsSigning?: WindowsSigningConfiguration;
}

export async function signExecutable(
  options: SignExecutableOptions,
): Promise<SigningResult> {
  requireExecutable(options.file);
  const platform = options.platform ?? process.platform;
  return getPlatformAdapter(platform).sign({
    file: options.file,
    mode: options.mode ?? 'optional',
    macos: options.macos ?? {},
    environment: options.environment ?? process.env,
    runner: options.runner ?? createCommandRunner(),
  });
}

export async function signExecutables(
  options: SignExecutablesOptions,
): Promise<SigningResult> {
  if (options.files.length === 0) {
    throw new Error('At least one executable is required for signing');
  }
  let result: SigningResult | undefined;
  for (const file of options.files) {
    result = await signExecutable({
      file,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.macos ? { macos: options.macos } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
    });
  }
  return result as SigningResult;
}

export function notarizeMacOSArchive(
  options: NotarizeMacOSArchiveOptions,
): void {
  requireExecutable(options.file);
  const environment = options.environment ?? process.env;
  const configuration = resolveMacOSNotarizationConfiguration(
    environment,
    false,
  );
  const runner = options.runner ?? createCommandRunner();
  runner.run(
    'xcrun',
    [
      'notarytool',
      'submit',
      options.file,
      '--apple-id',
      configuration.appleId,
      '--password',
      configuration.applePassword,
      '--team-id',
      configuration.teamId,
      '--wait',
    ],
    { sensitiveArgumentIndexes: [4, 6, 8] },
  );
}

export async function verifyExecutable(
  options: VerifyExecutableOptions,
): Promise<SigningResult> {
  requireExecutable(options.file);
  const platform = options.platform ?? process.platform;
  return getPlatformAdapter(platform).verify({
    file: options.file,
    mode: 'optional',
    macos: {},
    environment: options.environment ?? process.env,
    runner: options.runner ?? createCommandRunner(),
  });
}

function requireExecutable(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Executable does not exist: ${path}`);
  }
}
