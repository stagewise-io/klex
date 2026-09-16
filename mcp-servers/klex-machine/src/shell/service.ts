import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { type IPty, spawn } from 'node-pty';

import type { MachinePathResolver } from '../filesystem/paths.js';

const MAX_BUFFER_CHARACTERS = 1024 * 1024;
const MAX_READ_CHARACTERS = 256 * 1024;
export const MAX_SHELL_SESSIONS = 32;

export interface ShellSessionInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
  running: boolean;
  exitCode?: number;
  signal?: number;
  createdAt: string;
}

export interface ShellReadResult {
  id: string;
  output: string;
  cursor: number;
  truncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: number;
}

interface ShellSession {
  info: ShellSessionInfo;
  pty: IPty;
  output: string;
  startCursor: number;
  endCursor: number;
  events: EventEmitter;
}

export class ShellService {
  private readonly sessions = new Map<string, ShellSession>();

  constructor(
    private readonly paths: MachinePathResolver,
    private readonly maxSessions = MAX_SHELL_SESSIONS,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error('maxSessions must be a positive integer');
    }
  }

  create(
    options: {
      cwd?: string;
      shell?: string;
      args?: string[];
      cols?: number;
      rows?: number;
      env?: Record<string, string>;
    } = {},
  ): ShellSessionInfo {
    const exited =
      this.sessions.size >= this.maxSessions
        ? [...this.sessions.values()].find((session) => !session.info.running)
        : undefined;
    if (this.sessions.size >= this.maxSessions && !exited) {
      throw new Error(`Shell session limit reached: ${this.maxSessions}`);
    }
    const cwd = this.paths.resolve(options.cwd ?? '.');
    const shell = options.shell ?? defaultShell();
    const args = options.args ?? defaultShellArgs();
    const cols = validDimension(options.cols ?? 120, 'cols');
    const rows = validDimension(options.rows ?? 30, 'rows');
    const env = environment(options.env);
    ensureSpawnHelperExecutable();
    const terminal = spawn(shell, args, {
      cols,
      rows,
      cwd,
      env,
      name: 'xterm-256color',
      // node-pty's ConPTY cleanup helper can crash with AttachConsole errors.
      ...(process.platform === 'win32' ? { useConpty: false } : {}),
    });
    if (exited) this.close(exited.info.id);
    const info: ShellSessionInfo = {
      id: randomUUID(),
      shell,
      cwd,
      pid: terminal.pid,
      running: true,
      createdAt: new Date().toISOString(),
    };
    const session: ShellSession = {
      info,
      pty: terminal,
      output: '',
      startCursor: 0,
      endCursor: 0,
      events: new EventEmitter(),
    };
    terminal.onData((data) => {
      session.output += data;
      session.endCursor += data.length;
      if (session.output.length > MAX_BUFFER_CHARACTERS) {
        const removeCount = session.output.length - MAX_BUFFER_CHARACTERS;
        session.output = session.output.slice(removeCount);
        session.startCursor += removeCount;
      }
      session.events.emit('change');
    });
    terminal.onExit(({ exitCode, signal }) => {
      session.info.running = false;
      session.info.exitCode = exitCode;
      session.info.signal = signal;
      session.events.emit('change');
    });
    this.sessions.set(info.id, session);
    return { ...info };
  }

  write(id: string, data: string): void {
    const session = this.get(id);
    if (!session.info.running)
      throw new Error(`Shell session has exited: ${id}`);
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id).pty.resize(
      validDimension(cols, 'cols'),
      validDimension(rows, 'rows'),
    );
  }

  async read(options: {
    id: string;
    cursor?: number;
    waitMs?: number;
  }): Promise<ShellReadResult> {
    const session = this.get(options.id);
    const requestedCursor = options.cursor ?? session.startCursor;
    if (!Number.isInteger(requestedCursor) || requestedCursor < 0) {
      throw new Error('cursor must be a non-negative integer');
    }
    if (requestedCursor > session.endCursor) {
      throw new Error('cursor is beyond the available shell output');
    }
    const waitMs = options.waitMs ?? 0;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new Error('waitMs must be an integer from 0 to 30000');
    }
    if (
      waitMs > 0 &&
      requestedCursor >= session.endCursor &&
      session.info.running
    ) {
      await waitForChange(session, waitMs);
    }

    const cursor = Math.max(requestedCursor, session.startCursor);
    const available = session.output.slice(cursor - session.startCursor);
    const output = available.slice(0, MAX_READ_CHARACTERS);
    return {
      id: options.id,
      output,
      cursor: cursor + output.length,
      truncated:
        requestedCursor < session.startCursor ||
        available.length > MAX_READ_CHARACTERS,
      running: session.info.running,
      exitCode: session.info.exitCode,
      signal: session.info.signal,
    };
  }

  close(id: string): void {
    const session = this.get(id);
    if (session.info.running) session.pty.kill();
    this.sessions.delete(id);
  }

  list(): ShellSessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session.info }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private get(id: string): ShellSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown shell session: ${id}`);
    return session;
  }
}

let spawnHelperPrepared = false;

function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32' || spawnHelperPrepared) return;
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve('node-pty')));
  const helperDirectories = [
    'build/Release',
    'build/Debug',
    `prebuilds/${process.platform}-${process.arch}`,
  ];
  for (const directory of helperDirectories) {
    const helper = resolve(packageRoot, directory, 'spawn-helper');
    if (!existsSync(helper)) continue;
    chmodSync(helper, 0o755);
    spawnHelperPrepared = true;
    return;
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'powershell.exe';
  }
  return process.env.SHELL ?? '/bin/sh';
}

function defaultShellArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-i'];
}

function environment(
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...base, ...overrides };
}

function validDimension(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`${name} must be an integer from 1 to 1000`);
  }
  return value;
}

async function waitForChange(
  session: ShellSession,
  waitMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      session.events.off('change', onChange);
      resolve();
    }, waitMs);
    session.events.once('change', onChange);
  });
}
