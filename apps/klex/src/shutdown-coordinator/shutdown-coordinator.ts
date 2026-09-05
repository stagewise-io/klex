import { spawn } from 'node:child_process';

export type ShutdownMode = 'exit' | 'restart';

export interface RestartRequest {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly launcher: string;
}

export interface ShutdownCoordinatorOptions {
  readonly cleanup: () => Promise<void>;
  readonly closeUi: () => void;
  readonly exit: (code: number) => void;
  readonly onRestartError: (error: Error) => void;
  readonly restartProcess?: (request: RestartRequest) => Promise<number>;
  readonly timeoutMs?: number;
}

export interface ShutdownCoordinator {
  isShuttingDown(): boolean;
  requestExit(): void;
  requestRestart(request: RestartRequest): void;
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions,
): ShutdownCoordinator {
  let shuttingDown = false;

  const shutdown = (mode: ShutdownMode, restart?: RestartRequest) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      options.closeUi();
    } catch {
      // Best effort: cleanup and process lifecycle must still proceed.
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ status: 'timeout' }),
        options.timeoutMs ?? 3000,
      );
    });
    const cleanup = options.cleanup().then(
      () => ({ status: 'clean' as const }),
      (error: unknown) => ({
        status: 'error' as const,
        error:
          error instanceof Error
            ? error
            : new Error('Could not release application resources'),
      }),
    );
    void Promise.race([cleanup, timeout]).then(async (result) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (result.status === 'error') {
        if (mode === 'restart') options.onRestartError(result.error);
        options.exit(1);
        return;
      }
      if (mode === 'exit' || !restart) {
        options.exit(0);
        return;
      }
      if (result.status === 'timeout') {
        options.onRestartError(
          new Error('Timed out while releasing application resources'),
        );
        options.exit(1);
        return;
      }
      try {
        const exitCode = await (options.restartProcess ?? restartProcess)(
          restart,
        );
        options.exit(exitCode);
      } catch (error) {
        options.onRestartError(
          error instanceof Error ? error : new Error('Could not restart Klex'),
        );
        options.exit(1);
      }
    });
  };

  return {
    isShuttingDown: () => shuttingDown,
    requestExit: () => shutdown('exit'),
    requestRestart: (request) => shutdown('restart', request),
  };
}

async function restartProcess(request: RestartRequest): Promise<number> {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    const environment = Object.fromEntries(
      Object.entries(request.environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    process.chdir(request.cwd);
    process.execve(
      request.launcher,
      [request.launcher, ...request.arguments],
      environment,
    );
    throw new Error('Process replacement unexpectedly returned');
  }

  return superviseReplacement(request);
}

function superviseReplacement(request: RestartRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.launcher, [...request.arguments], {
      cwd: request.cwd,
      env: request.environment,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
