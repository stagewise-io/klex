import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLimitedResponse } from './read-limited-response';

const MAX_INSTALLER_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 1000;
const TERMINATION_GRACE_MS = 500;
const TERMINATION_POLL_MS = 25;
const TERMINATION_TIMEOUT_MS = 2_000;
const INSTALLER_TIMEOUT_MS = 10 * 60 * 1000;
const REPOSITORY = 'stagewise-io/klex';
const STRIPPED_ENVIRONMENT_KEYS = new Set([
  'KLEX_CHANNEL',
  'KLEX_INSTALL_LOCK_HELD',
  'KLEX_MANIFEST_URL',
  'KLEX_RELEASE_CHANNEL',
  'KLEX_RELEASE_TAG',
  'KLEX_VERSION',
]);

export interface InstallerRunRequest {
  readonly gitCommit: string;
  readonly installRoot: string;
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly version: string;
  readonly onProgress?: (message: string) => void;
}

export type FetchImplementation = typeof fetch;

export async function runImmutableInstaller(
  request: InstallerRunRequest,
  fetchImplementation: FetchImplementation = fetch,
): Promise<void> {
  const extension = request.platform === 'win32' ? 'ps1' : 'sh';
  if (!/^[a-f0-9]{40}$/.test(request.gitCommit)) {
    throw new Error('Updater commit identity is invalid');
  }
  const installerUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${request.gitCommit}/install.${extension}`;
  const directory = await mkdtemp(join(tmpdir(), 'klex-self-update-'));
  const installerPath = join(directory, `install.${extension}`);
  try {
    request.onProgress?.('Downloading updater');
    const response = await fetchImplementation(installerUrl, {
      redirect: 'error',
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Updater download failed with HTTP ${response.status}`);
    }
    const bytes = await readLimitedResponse(
      response,
      MAX_INSTALLER_BYTES,
      'Updater download has an invalid size',
    );
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INSTALLER_BYTES) {
      throw new Error('Updater download has an invalid size');
    }
    await writeFile(installerPath, bytes, { mode: 0o700 });
    if (request.platform !== 'win32') await chmod(installerPath, 0o700);

    request.onProgress?.('Installing update');
    await spawnInstaller(installerPath, request);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function spawnInstaller(
  installerPath: string,
  request: InstallerRunRequest,
): Promise<void> {
  const windows = request.platform === 'win32';
  const command = windows ? 'powershell.exe' : '/bin/sh';
  const commandArguments = windows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installerPath,
        '-Version',
        request.version,
        '-InstallDir',
        request.installRoot,
        '-NoModifyPath',
      ]
    : [
        installerPath,
        '--version',
        request.version,
        '--install-dir',
        request.installRoot,
        '--no-modify-path',
      ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArguments, {
      detached: !windows,
      env: sanitizedEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let termination: Promise<void> | undefined;
    let settled = false;
    const timeout = setTimeout(
      () => beginTermination('Updater timed out'),
      INSTALLER_TIMEOUT_MS,
    );
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    function beginTermination(reason: string): void {
      if (termination) return;
      termination = terminateInstallerTree(child.pid, windows, () =>
        child.kill('SIGKILL'),
      );
      void termination.then(
        () => settleReject(new Error(reason)),
        (error: unknown) => settleReject(error),
      );
    }
    const abort = () => beginTermination('Update cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.once('error', settleReject);
    child.once('exit', (code, signal) => {
      void (async () => {
        await termination;
        if (code === 0) {
          settleResolve();
          return;
        }
        const reason = signal
          ? `signal ${signal}`
          : `exit code ${code ?? 'unknown'}`;
        const detail = diagnostics.trim().slice(-MAX_ERROR_MESSAGE_BYTES);
        settleReject(
          new Error(
            `Updater failed with ${reason}${detail ? `: ${detail}` : ''}`,
          ),
        );
      })().catch(settleReject);
    });
  });
}

async function terminateInstallerTree(
  pid: number | undefined,
  windows: boolean,
  killChild: () => void,
): Promise<void> {
  if (pid === undefined) {
    killChild();
    return;
  }
  if (windows) {
    await terminateWindowsProcessTree(pid);
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() < deadline && isProcessGroupAlive(pid)) {
    await delay(TERMINATION_POLL_MS);
  }
  if (isProcessGroupAlive(pid)) signalProcessGroup(pid, 'SIGKILL');

  const killDeadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < killDeadline && isProcessGroupAlive(pid)) {
    await delay(TERMINATION_POLL_MS);
  }
  if (isProcessGroupAlive(pid)) {
    throw new Error('Could not terminate the updater process group');
  }
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.once('error', reject);
    taskkill.once('exit', (code) => {
      if (code === 0 || code === 128) resolve();
      else
        reject(
          new Error(`taskkill failed with exit code ${code ?? 'unknown'}`),
        );
    });
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !STRIPPED_ENVIRONMENT_KEYS.has(key),
    ),
  );
}
