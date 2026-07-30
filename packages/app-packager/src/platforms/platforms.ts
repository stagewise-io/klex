import type { CommandRunner } from '../command-runner/index.js';
import type { MacOSNotarizationConfiguration } from '../config/index.js';
import type {
  PlatformSigningOptions,
  SigningResult,
} from '../signing/signing.js';
import {
  prepareLinuxRuntime,
  signLinuxExecutable,
  stripLinuxExecutable,
  verifyLinuxExecutable,
} from './linux/index.js';
import {
  notarizeMacOSExecutable,
  prepareMacOSRuntime,
  signMacOSExecutable,
  stripMacOSExecutable,
  verifyMacOSExecutable,
} from './macos/index.js';
import {
  prepareWindowsRuntime,
  signWindowsExecutable,
  verifyWindowsExecutable,
} from './windows/index.js';

export interface PlatformAdapter {
  prepareRuntime(
    file: string,
    runner: CommandRunner,
    environment: NodeJS.ProcessEnv,
  ): void;
  strip(file: string, runner: CommandRunner): void;
  sign(options: PlatformSigningOptions): SigningResult;
  verify(options: PlatformSigningOptions): SigningResult;
  notarize(
    file: string,
    configuration: MacOSNotarizationConfiguration,
    runner: CommandRunner,
  ): void;
}

const windows: PlatformAdapter = {
  prepareRuntime: prepareWindowsRuntime,
  strip: () => undefined,
  sign: signWindowsExecutable,
  verify: verifyWindowsExecutable,
  notarize: () => undefined,
};

const macos: PlatformAdapter = {
  prepareRuntime: (file, runner) => prepareMacOSRuntime(file, runner),
  strip: stripMacOSExecutable,
  sign: signMacOSExecutable,
  verify: verifyMacOSExecutable,
  notarize: notarizeMacOSExecutable,
};

const linux: PlatformAdapter = {
  prepareRuntime: prepareLinuxRuntime,
  strip: stripLinuxExecutable,
  sign: signLinuxExecutable,
  verify: verifyLinuxExecutable,
  notarize: () => undefined,
};

export function getPlatformAdapter(platform: NodeJS.Platform): PlatformAdapter {
  if (platform === 'win32') return windows;
  if (platform === 'darwin') return macos;
  if (platform === 'linux') return linux;
  throw new Error(`Unsupported packaging platform: ${platform}`);
}
