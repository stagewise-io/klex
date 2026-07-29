import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

export interface WindowsMcpProcessOptions {
  readonly command: string;
  readonly launchMode: 'executable' | 'uvx';
  readonly port: number;
  readonly logging: RootLogger;
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
  readonly spawn?: typeof spawnWindowsMcp;
  readonly fetch?: typeof globalThis.fetch;
  readonly terminateProcessTree?: typeof terminateProcessTree;
  readonly onUnexpectedExit?: (error: Error) => void;
}

export interface WindowsMcpProcess {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly running: boolean;
}

type SpawnWindowsMcp = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

interface WindowsMcpProcessDependencies {
  readonly command: string;
  readonly launchMode: 'executable' | 'uvx';
  readonly port: number;
  readonly logger: ModuleLogger;
  readonly readinessTimeoutMs: number;
  readonly readinessIntervalMs: number;
  readonly spawn: SpawnWindowsMcp;
  readonly fetch: typeof globalThis.fetch;
  readonly terminateProcessTree: typeof terminateProcessTree;
  readonly onUnexpectedExit?: (error: Error) => void;
}

class WindowsMcpProcessModule implements WindowsMcpProcess {
  readonly #dependencies: WindowsMcpProcessDependencies;
  #child?: ChildProcessWithoutNullStreams;
  #starting?: Promise<void>;
  #started = false;
  #closed = false;
  #closing = false;

  constructor(dependencies: WindowsMcpProcessDependencies) {
    this.#dependencies = dependencies;
  }

  get running(): boolean {
    return this.#started && this.#child?.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error('Windows-MCP process is closed');
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    await this.#stopChild();
  }

  async #start(): Promise<void> {
    const args = [
      ...(this.#dependencies.launchMode === 'uvx' ? ['windows-mcp'] : []),
      'serve',
      '--transport',
      'streamable-http',
      '--stateless-http',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.#dependencies.port),
    ];
    const child = this.#dependencies.spawn(this.#dependencies.command, args);
    this.#child = child;
    this.#pipeDiagnostics(child.stdout, 'stdout');
    this.#pipeDiagnostics(child.stderr, 'stderr');
    child.once('exit', (code, signal) => {
      if (child !== this.#child) return;
      this.#started = false;
      if (!this.#closing) {
        this.#dependencies.onUnexpectedExit?.(
          new Error(
            `Windows-MCP exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });

    try {
      await this.#waitUntilReady(child);
      this.#started = true;
      this.#dependencies.logger.info(
        { port: this.#dependencies.port },
        'Windows-MCP is ready',
      );
    } catch (error) {
      await this.#stopChild();
      throw error;
    }
  }

  async #waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + this.#dependencies.readinessTimeoutMs;
    const url = `http://127.0.0.1:${this.#dependencies.port}/mcp`;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Windows-MCP exited before readiness (code=${child.exitCode})`,
        );
      }
      try {
        await this.#dependencies.fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(this.#dependencies.readinessIntervalMs),
        });
        return;
      } catch {
        await delay(this.#dependencies.readinessIntervalMs);
      }
    }
    throw new Error('Timed out waiting for Windows-MCP readiness');
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    if (!child || child.exitCode !== null) return;
    await this.#dependencies.terminateProcessTree(child);
  }

  #pipeDiagnostics(
    stream: NodeJS.ReadableStream,
    source: 'stdout' | 'stderr',
  ): void {
    stream.setEncoding('utf8');
    stream.on('data', (value: string) => {
      const message = value.trim();
      if (message) {
        this.#dependencies.logger.debug(
          { source, message },
          'Windows-MCP output',
        );
      }
    });
  }
}

export function createWindowsMcpProcess(
  options: WindowsMcpProcessOptions,
): WindowsMcpProcess {
  return new WindowsMcpProcessModule({
    command: options.command,
    launchMode: options.launchMode,
    port: options.port,
    logger: options.logging.child({
      name: 'windows-mcp-process',
      bindings: { module: 'windows-mcp-process' },
    }),
    readinessTimeoutMs: options.readinessTimeoutMs ?? 60_000,
    readinessIntervalMs: options.readinessIntervalMs ?? 250,
    spawn: options.spawn ?? spawnWindowsMcp,
    fetch: options.fetch ?? globalThis.fetch,
    terminateProcessTree: options.terminateProcessTree ?? terminateProcessTree,
    ...(options.onUnexpectedExit
      ? { onUnexpectedExit: options.onUnexpectedExit }
      : {}),
  });
}

function spawnWindowsMcp(
  command: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child);
    return;
  }
  await terminateSingleProcess(child);
}

async function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await terminateSingleProcess(child);
    return;
  }
  const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    taskkill.once('error', reject);
    taskkill.once('exit', resolve);
  });
  if (exitCode !== 0 && child.exitCode === null) {
    throw new Error(
      `Failed to terminate Windows-MCP process tree (${exitCode})`,
    );
  }
  await waitForExit(child, 5_000);
}

async function terminateSingleProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    if (!child.kill('SIGTERM')) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out terminating Windows-MCP process tree')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
