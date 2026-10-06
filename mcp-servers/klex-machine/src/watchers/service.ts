import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import type { MachinePathResolver } from '../filesystem/index.js';
import type {
  WatcherCompletion,
  WatcherRecordInfo,
} from '../notifications/index.js';

export const MAX_WATCHERS = 32;
export const MAX_WATCHER_LIFETIME_MS = 604_800_000;
const BUFFER_CHARACTERS = 64 * 1024;

export interface WatcherInfo extends WatcherRecordInfo {
  id: string;
  pid: number | null;
  status: 'running';
}

export interface WatcherHooks {
  onStart(info: WatcherInfo): Promise<void>;
  onFinish(info: WatcherInfo, result: WatcherCompletion): Promise<void>;
  onCancel(id: string): Promise<void>;
  onError(error: unknown): void;
}

interface RunningWatcher {
  info: WatcherInfo;
  child?: ChildProcess;
  output: string;
  timer?: ReturnType<typeof setTimeout>;
  startup?: Promise<void>;
  done: boolean;
  exitedAt?: string;
  killed?: boolean;
}

export class WatcherService {
  readonly #running = new Map<string, RunningWatcher>();
  #closed = false;
  constructor(
    private readonly paths: MachinePathResolver,
    private readonly hooks: WatcherHooks,
    private readonly maxWatchers = MAX_WATCHERS,
    private readonly now = Date.now,
  ) {}

  async create(options: {
    command: string;
    title: string;
    timeoutMs: number;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<WatcherInfo> {
    if (this.#closed) throw new Error('Watcher service is closed');
    if (this.#running.size >= this.maxWatchers)
      throw new Error(`Watcher limit reached: ${this.maxWatchers}`);
    if (!options.command || options.command.length > 16384)
      throw new Error('command must contain 1 to 16384 characters');
    if (!options.title || options.title.length > 200)
      throw new Error('title must contain 1 to 200 characters');
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1000 ||
      options.timeoutMs > MAX_WATCHER_LIFETIME_MS
    )
      throw new Error('timeoutMs must be an integer from 1000 to 604800000');
    const created = this.now();
    const info: WatcherInfo = {
      id: randomUUID(),
      watcherId: '',
      title: options.title,
      command: options.command,
      cwd: this.paths.resolve(options.cwd ?? '.'),
      pid: null,
      status: 'running',
      createdAt: new Date(created).toISOString(),
      deadlineAt: new Date(created + options.timeoutMs).toISOString(),
    };
    info.watcherId = info.id;
    const watcher: RunningWatcher = { info, output: '', done: false };
    // Reserve before awaiting persistence so concurrent creates respect the bound.
    this.#running.set(info.id, watcher);
    watcher.startup = (async () => {
      try {
        await this.hooks.onStart(info);
      } catch (error) {
        this.#running.delete(info.id);
        throw error;
      }
      if (this.#closed || watcher.done) {
        await this.hooks.onCancel(info.id);
        throw new Error('Watcher creation interrupted before starting');
      }
      if (this.now() >= Date.parse(info.deadlineAt)) {
        await this.#finish(watcher, 'timed_out', null, null);
        return;
      }
      try {
        const child = spawn(options.command, {
          shell: true,
          cwd: info.cwd,
          env: { ...process.env, ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        watcher.child = child;
        info.pid = child.pid ?? null;
        for (const stream of [child.stdout, child.stderr]) {
          const decoder = new StringDecoder('utf8');
          stream?.on('data', (chunk: Buffer) =>
            this.#append(watcher, decoder.write(chunk)),
          );
          stream?.on('end', () => this.#append(watcher, decoder.end()));
        }
        child.once('error', (error) => {
          this.#append(watcher, error.message);
          void this.#finish(watcher, 'failed', null, null);
        });
        child.once('exit', () => {
          watcher.exitedAt = new Date(this.now()).toISOString();
          clearTimeout(watcher.timer);
          // Descendants may keep stdout/stderr open after the command exits.
          // Stop them now, then let close drain output without reclassifying exit.
          this.#kill(watcher);
        });
        child.once('close', (code, signal) => {
          void this.#finish(
            watcher,
            code === 0 && !signal ? 'condition_met' : 'failed',
            code,
            signal,
          );
        });
        const checkDeadline = () => {
          if (watcher.done || watcher.exitedAt) return;
          const remaining = Date.parse(info.deadlineAt) - this.now();
          if (remaining <= 0) {
            void this.#finish(watcher, 'timed_out', null, null);
            return;
          }
          watcher.timer = setTimeout(checkDeadline, Math.min(remaining, 5000));
          watcher.timer.unref();
        };
        checkDeadline();
      } catch (error) {
        this.#append(
          watcher,
          error instanceof Error ? error.message : String(error),
        );
        await this.#finish(watcher, 'failed', null, null);
      }
    })();
    await watcher.startup;
    return { ...info };
  }

  list(): WatcherInfo[] {
    return [...this.#running.values()].map(({ info }) => ({ ...info }));
  }

  async cancel(id: string): Promise<void> {
    const watcher = this.#running.get(id);
    if (!watcher) throw new Error(`Unknown watcher: ${id}`);
    this.#stop(watcher);
    await this.hooks.onCancel(id);
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    const startups = [...this.#running.values()].map(
      (watcher) => watcher.startup,
    );
    for (const watcher of this.#running.values()) this.#stop(watcher);
    // Interrupted creates must remove their reservations before store shutdown.
    await Promise.allSettled(startups);
  }

  #append(watcher: RunningWatcher, text: string): void {
    watcher.output = (watcher.output + text).slice(-BUFFER_CHARACTERS);
  }

  #stop(watcher: RunningWatcher): void {
    watcher.done = true;
    clearTimeout(watcher.timer);
    this.#running.delete(watcher.info.id);
    this.#kill(watcher);
  }

  async #finish(
    watcher: RunningWatcher,
    outcome: WatcherCompletion['outcome'],
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    if (watcher.done) return;
    watcher.done = true;
    clearTimeout(watcher.timer);
    this.#running.delete(watcher.info.id);
    // Also clean up descendants left behind by a completed shell command.
    this.#kill(watcher);
    try {
      await this.hooks.onFinish(watcher.info, {
        outcome,
        exitCode,
        signal,
        finishedAt: watcher.exitedAt ?? new Date(this.now()).toISOString(),
        output: watcher.output,
      });
    } catch (error) {
      this.hooks.onError(error);
    }
  }

  #kill(watcher: RunningWatcher): void {
    const pid = watcher.child?.pid;
    if (!pid || watcher.killed) return;
    watcher.killed = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('error', this.hooks.onError);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return;
    }
    const escalation = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, 5000);
    escalation.unref();
  }
}
