import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterEach, it } from 'vitest';

export type Implementation = 'ts' | 'rust';

export const implementation = (process.env.KLEX_MACHINE_IMPL ??
  'ts') as Implementation;
if (implementation !== 'ts' && implementation !== 'rust')
  throw new Error(`Unknown KLEX_MACHINE_IMPL: ${implementation}`);

export const windows = process.platform === 'win32';
export const PUSH = 'io.stagewise/push-notifications';
export const PROTOCOL = '2026-07-28';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const contractDir = join(
  repositoryRoot,
  'mcp-servers',
  'klex-machine',
  'contract',
);

/**
 * A test that is known to fail on the listed implementations. It must keep
 * failing there, so a fixed gap shows up as a failure until the marker goes.
 */
export function parity(...pendingOn: Implementation[]): typeof it {
  return (pendingOn.includes(implementation) ? it.fails : it) as typeof it;
}

export function executable(target: Implementation = implementation): {
  file: string;
  args: string[];
} {
  const override =
    target === implementation ? process.env.KLEX_MACHINE_BIN : undefined;
  if (override) {
    const file = resolve(override);
    return /\.[cm]?js$/.test(file)
      ? { file: process.execPath, args: [file] }
      : { file, args: [] };
  }
  if (target === 'ts')
    return {
      file: process.execPath,
      args: [
        join(repositoryRoot, 'mcp-servers', 'klex-machine', 'dist', 'index.js'),
      ],
    };
  return {
    file: join(
      repositoryRoot,
      'mcp-servers',
      'klex-machine-rs',
      'dist',
      `klex-machine-rs${windows ? '.exe' : ''}`,
    ),
    args: [],
  };
}

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KLEX_MACHINE_DESKTOP: 'off',
    NO_COLOR: '1',
  };
  for (const key of Object.keys(env))
    if (key.startsWith('KLEX_MACHINE_') && key !== 'KLEX_MACHINE_DESKTOP')
      delete env[key];
  return env;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  for (const cleanup of pending) await cleanup();
});

const removeDirectory = (directory: string) =>
  rm(directory, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  }).catch((error: NodeJS.ErrnoException) => {
    // Windows keeps a killed server's shell children, and with them their cwd,
    // alive for a while after the server exits.
    if (!(windows && (error.code === 'EBUSY' || error.code === 'EPERM')))
      throw error;
  });

/** A real path under the OS temp dir, removed after the current test. */
export async function temporaryDirectory(
  prefix = 'klex machine ',
  manual = false,
): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  if (!manual) cleanups.push(() => removeDirectory(directory));
  return directory;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  implementation?: Implementation;
}

export async function runCli(
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const { file, args: prefix } = executable(options.implementation);
  const child = spawn(file, [...prefix, ...args], {
    cwd: options.cwd,
    env: { ...baseEnv(), ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  return { code, stdout, stderr };
}

export interface CliProcess {
  readonly child: ChildProcess;
  readonly output: { stdout: string; stderr: string };
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** Resolves once stdout contains `text`; rejects if the process exits first. */
  stdoutContains(text: string, timeout?: number): Promise<void>;
  stop(
    signal?: NodeJS.Signals,
  ): Promise<{ code: number | null; signal: string | null }>;
}

/** Spawns a long-running command, killed after the current test. */
export function spawnCli(
  args: string[],
  options: CliOptions & { stdin?: string } = {},
): CliProcess {
  const { file, args: prefix } = executable(options.implementation);
  const child = spawn(file, [...prefix, ...args], {
    cwd: options.cwd,
    env: { ...baseEnv(), ...options.env },
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (options.stdin !== undefined) child.stdin!.end(options.stdin);
  const output = { stdout: '', stderr: '' };
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (done) => {
      child.once('close', (code, signal) => done({ code, signal }));
      child.once('error', () => done({ code: null, signal: null }));
    },
  );
  let finished = false;
  void exited.then(() => {
    finished = true;
  });
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
    return exited;
  };
  cleanups.push(async () => {
    await stop('SIGKILL');
  });
  return {
    child,
    output,
    exited,
    stop,
    stdoutContains: (text, timeout = 20_000) =>
      waitFor(
        () => {
          if (output.stdout.includes(text)) return true;
          if (finished)
            throw new Error(
              `Process exited before printing ${JSON.stringify(text)}:\n${output.stdout}\n${output.stderr}`,
            );
          return undefined;
        },
        { timeout },
      ).then(() => undefined),
  };
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  resultType?: string;
}

export interface RequestOptions {
  push?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class Machine {
  readonly logs: Record<string, unknown>[] = [];
  private exit: Promise<{ code: number | null; signal: string | null }>;
  private nextId = 1;

  constructor(
    readonly child: ChildProcess,
    readonly port: number,
    readonly cwd: string,
    readonly dataDir: string,
    logs: Record<string, unknown>[],
    exit: Promise<{ code: number | null; signal: string | null }>,
    private readonly owned: string[] = [],
  ) {
    this.logs = logs;
    this.exit = exit;
  }

  /** Stops a manual machine and removes the directories it created. */
  async dispose(): Promise<void> {
    await this.stop('SIGKILL');
    for (const directory of this.owned) await removeDirectory(directory);
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get url(): string {
    return `${this.origin}/mcp`;
  }

  meta(push: boolean): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL,
      'io.modelcontextprotocol/clientInfo': {
        name: 'klex-machine-conformance',
        version: '1.0.0',
      },
      'io.modelcontextprotocol/clientCapabilities': push
        ? { extensions: { [PUSH]: {} } }
        : {},
    };
  }

  /** Sends a stateless JSON-RPC request and returns the raw HTTP response. */
  post(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<Response> {
    return fetch(this.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': PROTOCOL,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method,
        params: { ...params, _meta: this.meta(options.push ?? false) },
      }),
      signal: options.signal,
    });
  }

  async rpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<{ result?: T; error?: JsonRpcError }> {
    const response = await this.post(method, params, options);
    const text = await response.text();
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    return JSON.parse(data ?? text);
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<{ result?: ToolResult; error?: JsonRpcError }> {
    return this.rpc<ToolResult>(
      'tools/call',
      { name, arguments: args },
      options,
    );
  }

  /** Calls a tool that must succeed and parses its JSON text result. */
  async tool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const { result, error } = await this.call(name, args, options);
    if (error) throw new Error(`${name}: ${JSON.stringify(error)}`);
    const text = result?.content[0]?.text ?? 'null';
    if (result?.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text) as T;
  }

  /** Calls a tool that must fail and returns its error text. */
  async toolError(
    name: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<string> {
    const { result, error } = await this.call(name, args, options);
    if (error) throw new Error(`${name}: ${JSON.stringify(error)}`);
    if (!result?.isError)
      throw new Error(
        `${name} unexpectedly succeeded: ${JSON.stringify(result)}`,
      );
    return result.content[0]?.text ?? '';
  }

  async stop(
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<{ code: number | null; signal: string | null }> {
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill(signal);
    return this.exit;
  }

  exited(): Promise<{ code: number | null; signal: string | null }> {
    return this.exit;
  }
}

export interface StartOptions {
  cwd?: string;
  dataDir?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Keeps the machine past the current test; the caller must stop it. */
  manual?: boolean;
  /** Runs the other implementation, for data-directory takeover tests. */
  implementation?: Implementation;
}

/** Starts `serve --mode local` on an ephemeral port and waits for readiness. */
export async function startMachine(
  options: StartOptions = {},
): Promise<Machine> {
  const manual = options.manual ?? false;
  const owned: string[] = [];
  const own = async (prefix: string) => {
    const directory = await temporaryDirectory(prefix, manual);
    owned.push(directory);
    return directory;
  };
  const cwd = options.cwd ?? (await own('klex machine cwd '));
  const dataDir = options.dataDir ?? (await own('klex machine data '));
  const { file, args } = executable(options.implementation);
  const child = spawn(
    file,
    [
      ...args,
      'serve',
      '--mode',
      'local',
      '--port',
      '0',
      '--omit-host-details',
      '--data-dir',
      dataDir,
      '--cwd',
      cwd,
      ...(options.args ?? []),
    ],
    {
      env: { ...baseEnv(), ...options.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const logs: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (done) => {
      child.once('exit', (code, signal) => done({ code, signal }));
      child.once('error', () => done({ code: null, signal: null }));
    },
  );
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`klex-machine did not start:\n${stderr.join('\n')}`)),
      20_000,
    );
    createInterface({ input: child.stderr! }).on('line', (line) => {
      stderr.push(line);
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        logs.push(record);
        if (record.message === 'klex-machine MCP server listening') {
          clearTimeout(timer);
          resolvePort(record.port as number);
        }
      } catch {}
    });
    void exit.then(({ code }) => {
      clearTimeout(timer);
      reject(
        new Error(`klex-machine exited with ${code}:\n${stderr.join('\n')}`),
      );
    });
  });
  const machine = new Machine(child, port, cwd, dataDir, logs, exit, owned);
  if (!manual)
    cleanups.push(async () => {
      await machine.stop('SIGKILL');
    });
  return machine;
}

/** Polls until `check` returns a value other than undefined. */
export async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  { timeout = 10_000, interval = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for condition');
    await new Promise((done) => setTimeout(done, interval));
  }
}
