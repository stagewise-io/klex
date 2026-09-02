import { existsSync, statSync } from 'node:fs';

import {
  CommandExecutionError,
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
  readonly maxPollingAttempts?: number;
  readonly pollingIntervalMs?: number;
  readonly runner?: CommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
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

export async function notarizeMacOSArchive(
  options: NotarizeMacOSArchiveOptions,
): Promise<string> {
  requireExecutable(options.file);
  const environment = options.environment ?? process.env;
  const configuration = resolveMacOSNotarizationConfiguration(
    environment,
    false,
  );
  const runner = options.runner ?? createCommandRunner();
  const credentials = [
    '--apple-id',
    configuration.appleId,
    '--password',
    configuration.applePassword,
    '--team-id',
    configuration.teamId,
  ] as const;
  const submission = runner.run(
    'xcrun',
    [
      'notarytool',
      'submit',
      options.file,
      '--output-format',
      'json',
      ...credentials,
    ],
    { sensitiveArgumentIndexes: [6, 8, 10] },
  );
  const submissionId = parseNotarizationResponse(submission.stdout).id;
  if (!submissionId) {
    throw new Error('Apple notarization submission did not return an ID');
  }

  const maxAttempts = options.maxPollingAttempts ?? 120;
  const pollingIntervalMs = options.pollingIntervalMs ?? 15_000;
  const sleep = options.sleep ?? delay;
  let lastPollingError: CommandExecutionError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = runner.run(
        'xcrun',
        [
          'notarytool',
          'info',
          submissionId,
          '--output-format',
          'json',
          ...credentials,
        ],
        { sensitiveArgumentIndexes: [6, 8, 10] },
      );
      const status = parseNotarizationResponse(result.stdout).status;
      if (status === 'Accepted') return submissionId;
      if (status === 'Invalid' || status === 'Rejected') {
        throw new Error(
          `Apple notarization ${submissionId} was ${status}: ${readNotarizationLog(
            runner,
            submissionId,
            credentials,
          )}`,
        );
      }
      lastPollingError = undefined;
    } catch (error) {
      if (!(error instanceof CommandExecutionError)) throw error;
      lastPollingError = error;
    }

    if (attempt < maxAttempts) await sleep(pollingIntervalMs);
  }

  const detail = lastPollingError
    ? ` Last polling error: ${lastPollingError.message}`
    : '';
  throw new Error(
    `Apple notarization ${submissionId} did not complete after ${maxAttempts} polling attempts.${detail}`,
  );
}

interface NotarizationResponse {
  readonly id?: string;
  readonly status?: string;
}

function parseNotarizationResponse(output: string): NotarizationResponse {
  try {
    return JSON.parse(output) as NotarizationResponse;
  } catch (error) {
    throw new Error('Could not parse Apple notarization response', {
      cause: error,
    });
  }
}

function readNotarizationLog(
  runner: CommandRunner,
  submissionId: string,
  credentials: readonly string[],
): string {
  try {
    const result = runner.run(
      'xcrun',
      ['notarytool', 'log', submissionId, ...credentials],
      { sensitiveArgumentIndexes: [4, 6, 8] },
    );
    return result.stdout.trim() || 'Apple returned no rejection log';
  } catch (error) {
    return `rejection log unavailable: ${(error as Error).message}`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
