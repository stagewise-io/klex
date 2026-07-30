import { spawnSync } from 'node:child_process';

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly captureOutput?: boolean;
  readonly sensitiveArgumentIndexes?: readonly number[];
}

export type CommandOptions = CommandRunOptions;

export interface CommandResult {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ): CommandResult;
}

export class CommandExecutionError extends Error {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    details: { command: string; stdout: string; stderr: string; cause?: Error },
  ) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'CommandExecutionError';
    this.command = details.command;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

export interface CommandRunnerDependencies {
  readonly spawn?: typeof spawnSync;
}

class NativeCommandRunner implements CommandRunner {
  constructor(private readonly spawn: typeof spawnSync) {}

  run(
    command: string,
    arguments_: readonly string[],
    options: CommandRunOptions = {},
  ): CommandResult {
    const result = this.spawn(command, [...arguments_], {
      cwd: options.cwd,
      encoding: 'utf8',
      shell: false,
      stdio: options.captureOutput === false ? 'inherit' : 'pipe',
    });
    const displayArguments = arguments_.map((argument, index) =>
      options.sensitiveArgumentIndexes?.includes(index)
        ? '<redacted>'
        : argument,
    );
    const displayCommand = [command, ...displayArguments].join(' ');
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';

    if (result.error) {
      throw new CommandExecutionError(
        `Failed to start command: ${displayCommand}`,
        {
          command: displayCommand,
          stdout,
          stderr,
          cause: sanitizedCommandCause(result.error),
        },
      );
    }
    if (result.status !== 0) {
      throw new CommandExecutionError(
        `Command failed with exit code ${String(result.status)}: ${displayCommand}`,
        { command: displayCommand, stdout, stderr },
      );
    }

    return { command, arguments: arguments_, stdout, stderr };
  }
}

export function createCommandRunner(
  dependencies: CommandRunnerDependencies = {},
): CommandRunner {
  return new NativeCommandRunner(dependencies.spawn ?? spawnSync);
}

function sanitizedCommandCause(error: Error): Error {
  return new Error(error.message, { cause: error.cause });
}
