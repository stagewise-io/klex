import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { MachinePathResolver } from '../filesystem/paths.js';
import type { WorkloadHandle, WorkloadTracker } from '../workloads/index.js';

const MAX_BUFFER_CHARACTERS = 1024 * 1024;
const MAX_READ_CHARACTERS = 256 * 1024;
const MAX_WAIT_MS = 30_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
export const MAX_COMMANDS = 64;

/**
 * `foreground` commands are finite work: they keep the machine awake until
 * the process exits, and leftover processes in their group are terminated on
 * exit. `detached` commands (dev servers, watchers) never keep it awake.
 */
export type CommandMode = 'foreground' | 'detached';

export type CommandStatus =
  | 'running'
  | 'exited'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

export interface CommandInfo {
  id: string;
  command: string;
  cwd: string;
  mode: CommandMode;
  pid?: number;
  status: CommandStatus;
  exitCode?: number;
  signal?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

export interface CommandReadResult extends CommandInfo {
  output: string;
  cursor: number;
  truncated: boolean;
}

interface CommandRecord {
  info: CommandInfo;
  child?: ChildProcess;
  output: string;
  startCursor: number;
  endCursor: number;
  events: EventEmitter;
  workload?: WorkloadHandle;
  timeout?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  /** Status to report when the process exits after a requested stop. */
  stopReason?: 'cancelled' | 'timed_out';
}

/**
 * Structured command execution with explicit completion.
 *
 * Unlike PTY sessions, completion here is the process exit itself, so a
 * finite command stays protected after the tool call that started it returns.
 */
export class CommandService {
  readonly #commands = new Map<string, CommandRecord>();

  constructor(
    private readonly paths: MachinePathResolver,
    private readonly workloads: WorkloadTracker,
    private readonly maxCommands = MAX_COMMANDS,
  ) {
    if (!Number.isInteger(maxCommands) || maxCommands < 1) {
      throw new Error('maxCommands must be a positive integer');
    }
  }

  async run(options: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    mode?: CommandMode;
    shell?: string;
    timeoutMs?: number;
    waitMs?: number;
  }): Promise<CommandReadResult> {
    if (options.command.length === 0) throw new Error('command is required');
    const mode = options.mode ?? 'foreground';
    const waitMs = boundedWait(options.waitMs ?? 10_000);
    if (options.timeoutMs !== undefined) {
      if (mode === 'detached') {
        throw new Error('timeoutMs applies only to foreground commands');
      }
      validTimeout(options.timeoutMs);
    }
    this.#makeRoom();
    const cwd = this.paths.resolve(options.cwd ?? '.');
    const id = randomUUID();
    const record: CommandRecord = {
      info: {
        id,
        command: options.command,
        cwd,
        mode,
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      output: '',
      startCursor: 0,
      endCursor: 0,
      events: new EventEmitter(),
    };
    // Protection starts before spawn so no exit can race ahead of it.
    if (mode === 'foreground') {
      record.workload = this.workloads.acquire({
        kind: 'command',
        subjectId: id,
      });
    }
    this.#commands.set(id, record);

    const [file, args] = shellInvocation(options.command, options.shell);
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // A dedicated process group lets cancellation reach grandchildren.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this.#finish(record, { status: 'failed', error: message(error) });
      return this.#snapshot(record, 0);
    }
    record.child = child;
    record.info.pid = child.pid;
    const append = (chunk: Buffer) => appendOutput(record, chunk.toString());
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      this.#finish(record, { status: 'failed', error: message(error) });
    });
    child.once('exit', (code, signal) => {
      // Foreground means finite: processes left behind in the group would
      // otherwise run unprotected and unobserved after completion.
      if (mode === 'foreground') killGroup(child, 'SIGTERM');
      this.#finish(record, {
        status: record.stopReason ?? 'exited',
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      });
    });
    if (options.timeoutMs !== undefined) {
      record.timeout = setTimeout(
        () => this.#stop(record, 'timed_out'),
        options.timeoutMs,
      );
      record.timeout.unref();
    }
    await waitForExit(record, waitMs);
    return this.#snapshot(record, 0);
  }

  async read(options: {
    id: string;
    cursor?: number;
    waitMs?: number;
  }): Promise<CommandReadResult> {
    const record = this.#get(options.id);
    const cursor = options.cursor ?? record.startCursor;
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error('cursor must be a non-negative integer');
    }
    if (cursor > record.endCursor) {
      throw new Error('cursor is beyond the available command output');
    }
    return this.#snapshot(record, boundedWait(options.waitMs ?? 0), cursor);
  }

  cancel(id: string): CommandInfo {
    const record = this.#get(id);
    this.#stop(record, 'cancelled');
    return { ...record.info };
  }

  list(): CommandInfo[] {
    return [...this.#commands.values()]
      .map((record) => ({ ...record.info }))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  /** Removes a finished command's retained output. */
  remove(id: string): void {
    const record = this.#get(id);
    if (record.info.status === 'running') {
      throw new Error(`Command is still running: ${id}`);
    }
    this.#commands.delete(id);
  }

  closeAll(): void {
    for (const record of this.#commands.values()) {
      if (record.info.status !== 'running') continue;
      if (record.child) killGroup(record.child, 'SIGKILL');
      this.#finish(record, { status: 'cancelled' });
    }
    this.#commands.clear();
  }

  #stop(record: CommandRecord, reason: 'cancelled' | 'timed_out'): void {
    if (record.info.status !== 'running' || !record.child) return;
    record.stopReason ??= reason;
    killGroup(record.child, 'SIGTERM');
    record.killTimer ??= setTimeout(() => {
      if (record.child) killGroup(record.child, 'SIGKILL');
    }, KILL_GRACE_MS);
    record.killTimer.unref();
  }

  #finish(
    record: CommandRecord,
    outcome: Pick<CommandInfo, 'status' | 'exitCode' | 'signal' | 'error'>,
  ): void {
    if (record.info.status !== 'running') return;
    Object.assign(record.info, outcome, { endedAt: new Date().toISOString() });
    clearTimeout(record.timeout);
    // A pending forced kill still reaches stragglers that ignored SIGTERM.
    if (!record.stopReason) clearTimeout(record.killTimer);
    record.workload?.release();
    record.workload = undefined;
    record.events.emit('change');
  }

  async #snapshot(
    record: CommandRecord,
    waitMs: number,
    requestedCursor = record.startCursor,
  ): Promise<CommandReadResult> {
    if (
      waitMs > 0 &&
      requestedCursor >= record.endCursor &&
      record.info.status === 'running'
    ) {
      await waitForChange(record.events, waitMs);
    }
    const cursor = Math.max(requestedCursor, record.startCursor);
    const available = record.output.slice(cursor - record.startCursor);
    const output = available.slice(0, MAX_READ_CHARACTERS);
    return {
      ...record.info,
      output,
      cursor: cursor + output.length,
      truncated:
        requestedCursor < record.startCursor ||
        available.length > MAX_READ_CHARACTERS,
    };
  }

  #makeRoom(): void {
    if (this.#commands.size < this.maxCommands) return;
    const finished = [...this.#commands.values()]
      .filter((record) => record.info.status !== 'running')
      .sort((left, right) =>
        left.info.startedAt.localeCompare(right.info.startedAt),
      )[0];
    if (!finished) {
      throw new Error(`Command limit reached: ${this.maxCommands} running`);
    }
    this.#commands.delete(finished.info.id);
  }

  #get(id: string): CommandRecord {
    const record = this.#commands.get(id);
    if (!record) throw new Error(`Unknown command: ${id}`);
    return record;
  }
}

function appendOutput(record: CommandRecord, data: string): void {
  record.output += data;
  record.endCursor += data.length;
  if (record.output.length > MAX_BUFFER_CHARACTERS) {
    const removeCount = record.output.length - MAX_BUFFER_CHARACTERS;
    record.output = record.output.slice(removeCount);
    record.startCursor += removeCount;
  }
  record.events.emit('change');
}

function shellInvocation(
  command: string,
  shell: string | undefined,
): [string, string[]] {
  if (process.platform === 'win32') {
    return [
      shell ?? process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
    ];
  }
  return [shell ?? '/bin/sh', ['-c', command]];
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // ESRCH: the group already exited.
  }
}

function boundedWait(waitMs: number): number {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new Error(`waitMs must be an integer from 0 to ${MAX_WAIT_MS}`);
  }
  return waitMs;
}

function validTimeout(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(
  record: CommandRecord,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (record.info.status === 'running') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await waitForChange(record.events, remaining);
  }
}

async function waitForChange(
  events: EventEmitter,
  waitMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      events.off('change', onChange);
      resolve();
    }, waitMs);
    events.once('change', onChange);
  });
}
