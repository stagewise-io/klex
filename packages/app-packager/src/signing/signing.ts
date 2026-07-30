import { existsSync, statSync } from 'node:fs';

import {
  type CommandRunner,
  createCommandRunner,
} from '../command-runner/index.js';
import type {
  MacOSPackagingConfig,
  SigningMode,
  WindowsSigningConfiguration,
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
