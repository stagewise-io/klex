import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_INSTALLER_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 1000;
const REPOSITORY = 'stagewise-io/klex';
const STRIPPED_ENVIRONMENT_KEYS = new Set([
  'KLEX_CHANNEL',
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
    const bytes = new Uint8Array(await response.arrayBuffer());
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
      env: sanitizedEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const abort = () => child.kill();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.once('error', (error) => {
      request.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      request.signal?.removeEventListener('abort', abort);
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal
        ? `signal ${signal}`
        : `exit code ${code ?? 'unknown'}`;
      const detail = diagnostics.trim().slice(-MAX_ERROR_MESSAGE_BYTES);
      reject(
        new Error(
          `Updater failed with ${reason}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
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
